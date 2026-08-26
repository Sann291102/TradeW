import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionIntentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { istParts } from './execution-identity';
import {
  type QualificationVerdict,
  computeMetrics,
  deploymentCriteriaFromEnv,
  evaluateQualification,
  resolveCriteria,
} from './execution-qualification';
import { ExecutionStateService } from './execution-state.service';
import type { ExecutionProfileState } from './execution-state';

/**
 * Measures one profile's paper record and stores the verdict.
 *
 * The arithmetic lives in `execution-qualification.ts` (pure, unit-tested);
 * this is the database half — it reads the closed outcomes the paper engine
 * wrote, resolves the thresholds, persists the snapshot, and asks the state
 * service to promote or demote.
 *
 * ## Every number is read, never accumulated
 *
 * The metrics come from `ExecutionOutcome` rows, which `ExecutionLifecycleService`
 * writes from `Trade` rows the OMS booked. There is no counter incremented as
 * trades close, because a counter is a second copy of a fact and the two drift
 * — and a drifted counter here would be a qualification granted on numbers that
 * do not match the account.
 *
 * ## It promotes, and it can demote, and it can do neither
 *
 * A passing verdict asks for `MARK_QUALIFIED`, which the state machine permits
 * only from PAPER_ARMED/PAPER_RUNNING. A failing one asks for
 * `MARK_UNQUALIFIED`, which it permits only from PAPER_QUALIFIED — and NOT from
 * a live state, so a metrics sweep can never stand a live agent down on its
 * own. Both are `silent`, so the ordinary "nothing to change" outcome is not an
 * exception.
 */
@Injectable()
export class ExecutionQualificationService {
  private readonly logger = new Logger(ExecutionQualificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ExecutionStateService,
  ) {}

  /**
   * Evaluate one profile and persist the verdict.
   *
   * `promote` is false for a pure read (the console asking "where does this
   * stand?") and true for the sweep. A read that quietly moved the state
   * machine would make a GET a mutation.
   */
  async evaluate(profileId: string, options: { promote?: boolean } = {}) {
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      include: { account: { select: { id: true, paperWallet: { select: { startingBalance: true } } } } },
    });
    if (!profile) throw new NotFoundException(`No execution profile ${profileId}`);

    const [outcomes, criticalErrors] = await Promise.all([
      // CLOSED outcomes only. An open position has no realized result, and
      // counting its mark-to-market would let a qualification pass on a
      // paper profit that has not been taken.
      this.prisma.executionOutcome.findMany({
        where: { intent: { profileId }, result: { not: 'OPEN' }, exitAt: { not: null } },
        select: { realizedPnl: true, result: true, exitAt: true },
        orderBy: { exitAt: 'asc' },
      }),
      // FAILED, not REJECTED. A REJECTED intent is the risk policy working —
      // counting refusals as faults would make a well-behaved profile
      // permanently unqualifiable. FAILED means policy passed and the
      // submission still did not survive, which is the fault class §10 means.
      this.prisma.executionIntent.count({
        where: { profileId, status: ExecutionIntentStatus.FAILED },
      }),
    ]);

    const criteria = resolveCriteria(
      {
        qualMinTrades: profile.qualMinTrades,
        qualMinTradingDays: profile.qualMinTradingDays,
        qualMinWinRate: profile.qualMinWinRate,
        qualMaxDrawdownPct: profile.qualMaxDrawdownPct,
        qualMinNetPnl: profile.qualMinNetPnl != null ? Number(profile.qualMinNetPnl) : null,
        qualMaxLosingStreak: profile.qualMaxLosingStreak,
        qualMaxCriticalErrors: profile.qualMaxCriticalErrors,
      },
      deploymentCriteriaFromEnv(),
    );

    const metrics = computeMetrics({
      trades: outcomes.map((o) => ({
        realizedPnl: Number(o.realizedPnl),
        result: o.result,
        exitAt: o.exitAt!,
      })),
      // The account's own opening balance anchors the equity curve. A wallet
      // that does not exist yet has traded nothing, so the default matches
      // `OrderService.ensureWallet` rather than being zero — dividing a
      // drawdown by zero peak equity is how this metric produces Infinity.
      startingEquity: profile.account.paperWallet
        ? Number(profile.account.paperWallet.startingBalance)
        : 1_000_000,
      criticalErrors,
      dayKeyOf: (d) => istParts(d).dayKey,
    });

    const verdict = evaluateQualification(metrics, criteria);
    await this.persist(profileId, verdict);

    if (options.promote) {
      const state = profile.state as ExecutionProfileState;
      if (verdict.passed && (state === 'PAPER_ARMED' || state === 'PAPER_RUNNING')) {
        await this.state.apply(profileId, 'MARK_QUALIFIED', 'system', {
          reason: `Paper qualification met: ${metrics.trades} trades, ${metrics.winRate == null ? 'n/a' : `${Math.round(metrics.winRate)}%`} win rate.`,
          silent: true,
        });
        this.logger.log(`${profile.name}: paper qualification PASSED (${metrics.trades} trades).`);
      } else if (!verdict.passed && state === 'PAPER_QUALIFIED') {
        await this.state.apply(profileId, 'MARK_UNQUALIFIED', 'system', {
          reason: `Qualification lapsed: ${verdict.unmet.map((u) => u.label).join(', ')}.`,
          silent: true,
        });
        this.logger.warn(`${profile.name}: paper qualification LAPSED — ${verdict.unmet.map((u) => u.id).join(', ')}.`);
      }
    }

    return this.present(profileId, verdict);
  }

  /** Evaluate every profile that is paper-executing. One failure never stops the rest. */
  async evaluateAll() {
    const profiles = await this.prisma.executionProfile.findMany({
      where: { state: { in: ['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED'] } },
      select: { id: true, name: true },
    });
    const results: { profileId: string; passed: boolean }[] = [];
    for (const p of profiles) {
      try {
        const r = await this.evaluate(p.id, { promote: true });
        results.push({ profileId: p.id, passed: r.passed });
      } catch (err) {
        this.logger.error(`qualification sweep failed for ${p.name}`, err as Error);
      }
    }
    return results;
  }

  /** The stored verdict, or a freshly computed one when none exists yet. */
  async current(profileId: string) {
    const row = await this.prisma.executionQualification.findUnique({ where: { profileId } });
    if (!row) return this.evaluate(profileId);
    return {
      profileId,
      evaluatedAt: row.evaluatedAt.toISOString(),
      passed: row.passed,
      metrics: {
        trades: row.trades,
        wins: row.wins,
        losses: row.losses,
        scratches: row.scratches,
        winRate: row.winRate,
        netPnl: Number(row.netPnl),
        grossProfit: Number(row.grossProfit),
        grossLoss: Number(row.grossLoss),
        maxDrawdownPct: row.maxDrawdownPct,
        maxLosingStreak: row.maxLosingStreak,
        tradingDays: row.tradingDays,
        criticalErrors: row.criticalErrors,
        firstTradeAt: row.firstTradeAt?.toISOString() ?? null,
        lastTradeAt: row.lastTradeAt?.toISOString() ?? null,
      },
      criteria: row.criteria as unknown as QualificationVerdict['criteria'],
      results: row.results as unknown as QualificationVerdict['results'],
      unmet: (row.results as unknown as QualificationVerdict['results']).filter((r) => !r.met),
    };
  }

  private async persist(profileId: string, verdict: QualificationVerdict) {
    const m = verdict.metrics;
    const data = {
      evaluatedAt: new Date(),
      passed: verdict.passed,
      trades: m.trades,
      wins: m.wins,
      losses: m.losses,
      scratches: m.scratches,
      winRate: m.winRate,
      netPnl: new Prisma.Decimal(m.netPnl.toFixed(2)),
      grossProfit: new Prisma.Decimal(m.grossProfit.toFixed(2)),
      grossLoss: new Prisma.Decimal(m.grossLoss.toFixed(2)),
      maxDrawdownPct: m.maxDrawdownPct,
      maxLosingStreak: m.maxLosingStreak,
      tradingDays: m.tradingDays,
      criticalErrors: m.criticalErrors,
      firstTradeAt: m.firstTradeAt,
      lastTradeAt: m.lastTradeAt,
      criteria: verdict.criteria as unknown as Prisma.InputJsonValue,
      results: verdict.results as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.executionQualification.upsert({
      where: { profileId },
      create: { profileId, ...data },
      update: data,
    });
  }

  private present(profileId: string, verdict: QualificationVerdict) {
    return {
      profileId,
      evaluatedAt: new Date().toISOString(),
      passed: verdict.passed,
      metrics: {
        ...verdict.metrics,
        firstTradeAt: verdict.metrics.firstTradeAt?.toISOString() ?? null,
        lastTradeAt: verdict.metrics.lastTradeAt?.toISOString() ?? null,
      },
      criteria: verdict.criteria,
      results: verdict.results,
      unmet: verdict.unmet,
    };
  }
}
