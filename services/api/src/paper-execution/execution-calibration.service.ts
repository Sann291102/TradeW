import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MIN_CALIBRATION_TRADES,
  calibrationKey,
  floorAdjustment,
  foldOutcome,
  type CalibrationIdentity,
  type CalibrationSample,
} from './execution-calibration';

/**
 * The database half of bounded learning.
 *
 * The arithmetic and every bound live in `execution-calibration.ts` (pure,
 * asserted); this reads and writes the rows.
 *
 * ## The loop, and how it is checkable
 *
 *     trade #1 closes
 *       → recordOutcome()  folds its R into the bucket, bumps `version`
 *     trade #2 is decided
 *       → adjustmentFor()  reads that bucket
 *       → the intent stores `calibrationVersion` = the version it read
 *
 * So "the agent learned" is not a claim about a log line. It is a join: an
 * `ExecutionJournal` row records the version its outcome PRODUCED, and a later
 * `ExecutionIntent` records the version it CONSUMED. If the second is greater
 * than or equal to the first, that outcome reached that decision. If nothing
 * ever consumes a version, the loop is open and the join says so.
 */
@Injectable()
export class ExecutionCalibrationService {
  private readonly logger = new Logger(ExecutionCalibrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * What this bucket has earned, for the decision about to be made.
   *
   * Returns a zero adjustment (never null) when no bucket exists yet, so the
   * caller has one code path. `version: 0` then records honestly that a
   * calibration was consulted and had nothing to say — which is different from
   * a calibration never having been consulted at all, and the console shows
   * the difference.
   */
  async adjustmentFor(id: CalibrationIdentity): Promise<{
    key: string;
    version: number;
    adjustment: number;
    trades: number;
    avgRMultiple: number | null;
    winRate: number | null;
  }> {
    const key = calibrationKey(id);
    const row = await this.prisma.strategyCalibration.findUnique({ where: { key } });
    if (!row) {
      return { key, version: 0, adjustment: 0, trades: 0, avgRMultiple: null, winRate: null };
    }
    return {
      key,
      version: row.version,
      adjustment: row.confidenceAdjustment,
      trades: row.trades,
      avgRMultiple: row.avgRMultiple == null ? null : Number(row.avgRMultiple),
      winRate: row.winRate,
    };
  }

  /**
   * Fold one completed trade into its bucket.
   *
   * ## Why the whole thing is one transaction
   *
   * Read-modify-write on a running mean. Two concurrent folds that both read
   * the same `trades` would each write `trades + 1`, losing one trade and
   * corrupting the mean it divides by. The reconcile tick is leader-elected so
   * this is already serialised in practice; the transaction is what makes it
   * correct rather than merely unlikely.
   *
   * Idempotent by `lastOutcomeIntentId`: folding the same intent twice — which
   * a retried reconcile pass would do — is refused rather than double-counted.
   */
  async recordOutcome(input: {
    identity: CalibrationIdentity;
    intentId: string;
    result: string;
    realizedPnl: number;
    /** realizedPnl / riskBudget. Null when the intent recorded no budget. */
    rMultiple: number | null;
  }): Promise<{ key: string; version: number; adjustment: number; trades: number } | null> {
    const key = calibrationKey(input.identity);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.strategyCalibration.findUnique({ where: { key } });

        if (existing?.lastOutcomeIntentId === input.intentId) {
          // Already folded. A reconcile retry must not count a trade twice.
          return { key, version: existing.version, adjustment: existing.confidenceAdjustment, trades: existing.trades };
        }

        const previous: CalibrationSample = existing
          ? {
              trades: existing.trades,
              wins: existing.wins,
              losses: existing.losses,
              scratches: existing.scratches,
              grossPnl: Number(existing.grossPnl),
              avgRMultiple: existing.avgRMultiple == null ? null : Number(existing.avgRMultiple),
            }
          : { trades: 0, wins: 0, losses: 0, scratches: 0, grossPnl: 0, avgRMultiple: null };

        const folded = foldOutcome(previous, {
          result: input.result,
          realizedPnl: input.realizedPnl,
          rMultiple: input.rMultiple,
        });
        const adjustment = floorAdjustment(folded);
        const decided = folded.wins + folded.losses;
        const winRate = decided > 0 ? folded.wins / decided : null;

        const saved = await tx.strategyCalibration.upsert({
          where: { key },
          create: {
            key,
            agent: input.identity.agent,
            symbol: input.identity.symbol.toUpperCase(),
            strategyId: input.identity.strategyId,
            strategyVersion: input.identity.strategyVersion,
            regime: input.identity.regime,
            trades: folded.trades,
            wins: folded.wins,
            losses: folded.losses,
            scratches: folded.scratches,
            grossPnl: folded.grossPnl,
            avgRMultiple: folded.avgRMultiple ?? undefined,
            winRate,
            confidenceAdjustment: adjustment,
            version: 1,
            lastOutcomeIntentId: input.intentId,
            lastUpdatedAt: new Date(),
          },
          update: {
            trades: folded.trades,
            wins: folded.wins,
            losses: folded.losses,
            scratches: folded.scratches,
            grossPnl: folded.grossPnl,
            avgRMultiple: folded.avgRMultiple ?? undefined,
            winRate,
            confidenceAdjustment: adjustment,
            version: { increment: 1 },
            lastOutcomeIntentId: input.intentId,
            lastUpdatedAt: new Date(),
          },
        });

        this.logger.log(
          `calibration ${key} → v${saved.version}: ${saved.trades} trade(s), avg ${folded.avgRMultiple ?? 'n/a'}R, ` +
            `floor adjustment ${adjustment >= 0 ? '+' : ''}${adjustment}` +
            (saved.trades < MIN_CALIBRATION_TRADES ? ` (below the ${MIN_CALIBRATION_TRADES}-trade sample floor, so still 0)` : ''),
        );

        return { key, version: saved.version, adjustment: saved.confidenceAdjustment, trades: saved.trades };
      });
    } catch (err) {
      // Learning must never fail a trade's accounting. The outcome and the
      // journal are the record; the calibration is derived from them and can
      // be recomputed. Losing it costs an adjustment, not a P&L.
      this.logger.error(`calibration fold failed for ${key}`, err as Error);
      return null;
    }
  }

  /** Every bucket, for the console. Read-only. */
  async all() {
    const rows = await this.prisma.strategyCalibration.findMany({ orderBy: { lastUpdatedAt: 'desc' }, take: 200 });
    return rows.map((r) => ({
      key: r.key,
      agent: r.agent,
      symbol: r.symbol,
      strategyId: r.strategyId,
      strategyVersion: r.strategyVersion,
      regime: r.regime,
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      scratches: r.scratches,
      grossPnl: Number(r.grossPnl),
      avgRMultiple: r.avgRMultiple == null ? null : Number(r.avgRMultiple),
      winRate: r.winRate,
      confidenceAdjustment: r.confidenceAdjustment,
      version: r.version,
      // Stated explicitly rather than left for the reader to infer from the
      // trade count: "0 because it has not learned anything" and "0 because it
      // has not seen enough trades to be allowed to" are different facts.
      active: r.trades >= MIN_CALIBRATION_TRADES,
      sampleFloor: MIN_CALIBRATION_TRADES,
      lastUpdatedAt: r.lastUpdatedAt.toISOString(),
    }));
  }
}
