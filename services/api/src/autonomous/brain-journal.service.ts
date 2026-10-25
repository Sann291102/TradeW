/**
 * The learning dataset's writer.
 *
 * Turns a `ScanResult` into rows: one `AutonomousScan` for what the brain saw,
 * and one `AutonomousCandidate` per decision it reached. Nothing here executes
 * anything, and nothing here reads a decision back to influence one.
 *
 * ## Idempotent by BAR, not by poll
 *
 * The observer polls every 30 s against a 15-minute timeframe, so thirty passes
 * see the same closed bars and reach the same decision. Writing each one would
 * inflate the dataset thirtyfold with exact duplicates and bias every aggregate
 * toward whichever setups happened to persist longest across a bar.
 *
 * So the unit of record is `(symbol, timeframe, signalBarAt)` for a scan and
 * `(symbol, setupId, timeframe, signalBarAt)` for a candidate, both enforced by
 * unique constraints rather than by a check-then-write (which races two
 * workers). A repeated poll UPDATES the scan's volatile counters and leaves
 * every candidate alone.
 *
 * ## Candidates are written once and never updated
 *
 * `createMany({ skipDuplicates: true })`, deliberately, rather than an upsert.
 * A candidate records what the brain believed at a moment; re-deciding the same
 * bar later in that bar's life (with more of the forming bar visible) would
 * quietly rewrite history, and the question this dataset exists to answer —
 * "was the original reasoning correct?" — is unanswerable once the original
 * reasoning has been edited by hindsight.
 *
 * The FIRST decision on a bar is the one kept, because it is the one that would
 * actually have been acted on.
 *
 * ## A scan with no signal bar
 *
 * A closed market or a data fault produces no bar to key on. Those rows carry a
 * null `signalBarAt` and are written at most once per (symbol, timeframe) by the
 * same unique constraint — Postgres treats NULLs as distinct in a unique index,
 * so this would otherwise append one row per poll forever. `recordSkip` handles
 * it explicitly rather than relying on the constraint.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type AutonomousScanStatus } from '@prisma/client';
import { latestBarAt, type TradeCandidate } from '@tradew/strategy-core';
import { PrismaService } from '../prisma/prisma.service';
import { BRAIN_VERSION } from './brain-version';
import type { ScanResult, ScanStatus } from './setup-scanner.service';

/** How long a skip row is reused before another is written for the same symbol. */
const SKIP_DEDUPE_MS = 15 * 60_000;

const STATUS_MAP: Record<ScanStatus, AutonomousScanStatus> = {
  scanned: 'SCANNED',
  'skipped-closed': 'SKIPPED_CLOSED',
  'skipped-disabled': 'SKIPPED_DISABLED',
  'data-unavailable': 'DATA_UNAVAILABLE',
  'not-tradable': 'NOT_TRADABLE',
};

export interface JournalWrite {
  scanId: string | null;
  candidatesWritten: number;
  /** True when this bar had already been journalled — the common case. */
  deduped: boolean;
}

@Injectable()
export class BrainJournalService {
  private readonly logger = new Logger(BrainJournalService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persist one scan and its candidates. Safe to call on every poll. */
  async record(result: ScanResult, venue: string, now: Date = new Date()): Promise<JournalWrite> {
    if (result.status !== 'scanned') {
      return this.recordSkip(result, venue, now);
    }

    // Every candidate in one scan shares a signal bar — it is a property of the
    // snapshot, not of the setup. Taken from the first candidate rather than
    // recomputed so the scan and its candidates can never disagree.
    const signalBarAt = result.candidates[0]?.signalBarAt ?? null;
    const accepted = result.candidates.filter((c) => c.accepted).length;

    // A scanned market with no candidate at all has no bar to key on — the
    // meaningfulness filter dropped everything, so nothing carries a signal
    // bar. Those go down the skip path, which dedupes on a time window
    // instead: keying them on a null would append a row per poll forever,
    // because Postgres treats NULLs in a unique index as distinct.
    if (signalBarAt === null) {
      return this.recordSkip({ ...result, detail: result.detail ?? 'Scanned; no setup came within one rule of validating.' }, venue, now);
    }

    try {
      const scan = await this.prisma.autonomousScan.upsert({
        where: {
          symbol_timeframe_signalBarAt: {
            symbol: result.symbol,
            timeframe: this.timeframe(result),
            signalBarAt,
          },
        },
        create: {
          market: result.market ?? 'UNKNOWN',
          symbol: result.symbol,
          venue,
          timeframe: this.timeframe(result),
          scannedAt: now,
          signalBarAt,
          status: 'SCANNED',
          dataSource: result.source,
          dataAgeSeconds: result.dataAgeSeconds,
          lastPrice: this.decimal(result.candidates[0]?.features.lastPrice ?? null),
          regime: result.candidates[0]?.regime ?? null,
          candidateCount: result.candidates.length,
          acceptedCount: accepted,
          brainVersion: BRAIN_VERSION,
        },
        // Only the volatile facts are refreshed. `signalBarAt`, the decision
        // itself and the brain version are not — a later poll on the same bar
        // is the same decision seen again, not a new one.
        update: {
          dataAgeSeconds: result.dataAgeSeconds,
          candidateCount: result.candidates.length,
          acceptedCount: accepted,
        },
      });

      const written = await this.writeCandidates(scan.id, result, venue);
      return { scanId: scan.id, candidatesWritten: written, deduped: written === 0 };
    } catch (err) {
      // Journalling must never break the brain. An observer that crashes on a
      // write is worse than one that misses a row: the whole point is that it
      // runs continuously and cheaply beside production.
      this.logger.error(
        `journal write failed for ${result.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { scanId: null, candidatesWritten: 0, deduped: false };
    }
  }

  private async writeCandidates(scanId: string, result: ScanResult, venue: string): Promise<number> {
    if (result.candidates.length === 0) return 0;

    const rows = result.candidates.map((c) => this.toRow(scanId, c, venue));
    // `skipDuplicates` is the immutability guarantee: a candidate already
    // written for this (symbol, setup, bar) is left exactly as it was.
    const created = await this.prisma.autonomousCandidate.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return created.count;
  }

  private toRow(
    scanId: string,
    c: TradeCandidate,
    venue: string,
  ): Prisma.AutonomousCandidateCreateManyInput {
    const plan = c.plan;
    return {
      scanId,
      market: c.market,
      symbol: c.symbol,
      venue,
      timeframe: c.timeframe,
      decidedAt: c.decidedAt,
      signalBarAt: c.signalBarAt,
      setupId: c.setupId,
      setupName: c.setupName,
      setupVersion: c.setupVersion,
      archetype: c.archetype,
      brainVersion: BRAIN_VERSION,
      bias: c.bias,
      direction: c.direction,
      quality: c.quality,
      accepted: c.accepted,
      rejectionReason: c.rejectionReason,
      rejectionDetail: c.rejectionDetail,
      entry: this.decimal(plan?.entry ?? null),
      stop: this.decimal(plan?.stop ?? null),
      target: this.decimal(plan?.target ?? null),
      riskPerUnit: this.decimal(plan?.riskPerUnit ?? null),
      rewardPerUnit: this.decimal(plan?.rewardPerUnit ?? null),
      plannedRR: this.decimal(plan?.plannedRR ?? null),
      riskAtr: this.decimal(plan?.riskAtr ?? null),
      targetAtr: this.decimal(plan?.targetAtr ?? null),
      anchorArchetype: plan?.anchor.archetype ?? null,
      anchorLevel: this.decimal(plan?.anchor.level ?? null),
      anchorNote: plan?.anchor.note ?? null,
      regime: c.regime,
      features: c.features as unknown as Prisma.InputJsonValue,
      confirmed: c.confirmed as unknown as Prisma.InputJsonValue,
      unmet: c.unmet as unknown as Prisma.InputJsonValue,
      invalidated: c.invalidated as unknown as Prisma.InputJsonValue,
      explanation: c.explanation,
    };
  }

  /**
   * A scan that produced no decision — closed, disabled, faulted.
   *
   * These carry no signal bar, so the unique constraint cannot dedupe them
   * (Postgres treats NULLs as distinct). Without an explicit window a closed
   * market would append a row every 30 s all night, which is exactly the
   * 98%-noise ledger this dataset was designed to avoid.
   */
  private async recordSkip(result: ScanResult, venue: string, now: Date): Promise<JournalWrite> {
    try {
      const since = new Date(now.getTime() - SKIP_DEDUPE_MS);
      const recent = await this.prisma.autonomousScan.findFirst({
        where: {
          symbol: result.symbol,
          status: STATUS_MAP[result.status],
          scannedAt: { gte: since },
        },
        select: { id: true },
      });
      if (recent) return { scanId: recent.id, candidatesWritten: 0, deduped: true };

      const scan = await this.prisma.autonomousScan.create({
        data: {
          market: result.market ?? 'UNKNOWN',
          symbol: result.symbol,
          venue,
          timeframe: this.timeframe(result),
          scannedAt: now,
          signalBarAt: null,
          status: STATUS_MAP[result.status],
          detail: result.detail,
          dataSource: result.source,
          dataAgeSeconds: result.dataAgeSeconds,
          brainVersion: BRAIN_VERSION,
        },
      });
      return { scanId: scan.id, candidatesWritten: 0, deduped: false };
    } catch (err) {
      this.logger.error(
        `journal skip-write failed for ${result.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { scanId: null, candidatesWritten: 0, deduped: false };
    }
  }

  /**
   * The persisted row id for an in-memory decision.
   *
   * Execution is keyed on the JOURNALLED candidate, not the in-memory one, so
   * a decision that failed to journal is deliberately unexecutable — the row
   * id is what `AutonomousTrade.candidateId` makes unique, and without it
   * there is nothing for idempotency to hang on.
   */
  async findCandidateId(candidate: TradeCandidate): Promise<string | null> {
    const row = await this.prisma.autonomousCandidate.findFirst({
      where: {
        symbol: candidate.symbol,
        setupId: candidate.setupId,
        timeframe: candidate.timeframe,
        signalBarAt: candidate.signalBarAt,
        accepted: candidate.accepted,
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private timeframe(result: ScanResult): string {
    return result.candidates[0]?.timeframe ?? '15m';
  }

  /** Null stays null. A missing measurement is never stored as zero. */
  private decimal(value: number | null): Prisma.Decimal | null {
    return value === null || value === undefined || Number.isNaN(value)
      ? null
      : new Prisma.Decimal(value);
  }
}

/** Re-exported for the resolver, which keys its forward walk off the same bar. */
export { latestBarAt };
