import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MemoryStore } from '@tradew/ai-core';
import { MarketDataProvider } from '@tradew/types';
import { PrismaService } from '../prisma.service';
import { MARKET_DATA } from '../intelligence/market-intelligence.service';
import { isMarketOpen } from '../market-clock';
import { MEMORY_STORE } from './tokens';

interface PatternMetadata {
  pattern: string;
  symbol: string;
  priceAtDetection: number;
  detectedAt: string;
  outcome: string | null;
  outcomeMovePct?: number;
  outcomeEvaluatedAt?: string;
}

/**
 * Continuous Learning from Outcomes — pattern occurrences (Pattern
 * Recognition Engine's output) start with outcome: null. Once enough time
 * has passed to judge them, this tags what actually happened: price moved
 * further in one direction, or stayed put ("unclear"). Directional labels
 * only (continued_up/continued_down/unclear) — deliberately not
 * pattern-specific "confirmed/failed" semantics, which would require
 * opinionated per-pattern interpretation this phase doesn't build yet.
 *
 * ## Why this has its own timer
 *
 * It used to piggyback on `/observe` alone — five rows per call, fire and
 * forget — on the reasoning that Sentinel already runs continuously during
 * market hours. That stopped being true of the writers: `MarketWatchService`
 * records occurrences on every sweep and does NOT call `/observe`, so on a day
 * with light request traffic the watch wrote occurrences faster than
 * `/observe` tagged them and the untagged backlog grew all session.
 *
 * That backlog is not cosmetic. An occurrence with `outcome: null` is invisible
 * to `StrategyIntelligenceService.baseRateFor`, which counts only tagged rows —
 * so a starved evaluator directly starves the live-performance gate, and a
 * directional read stays withheld not because the pattern is unproven but
 * because nobody measured it. The tagger has to run on the same cadence as the
 * writers, which means its own timer.
 *
 * The `/observe` call is deliberately KEPT. It costs nothing when the backlog
 * is empty, and it means a burst of requests helps clear a backlog rather than
 * only adding to it. The two paths are safe to overlap: `evaluatePending` picks
 * rows with `outcome: null` and writes a non-null outcome, so the worst case
 * of a race is one row evaluated twice with the same result.
 */
@Injectable()
export class OutcomeLearningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutcomeLearningService.name);
  private static readonly MIN_AGE_MS = 15 * 60_000;
  private static readonly MOVE_THRESHOLD_PCT = 0.3;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private ticks = 0;
  private evaluatedTotal = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
    @Inject(MARKET_DATA) private readonly marketData: MarketDataProvider,
  ) {}

  onModuleInit(): void {
    if (process.env.SENTINEL_OUTCOME_LEARNING_TICK === 'false') {
      this.logger.log(
        'outcome-learning tick disabled (SENTINEL_OUTCOME_LEARNING_TICK=false) — occurrences are tagged only ' +
          'by /observe traffic, so base rates will lag the watch on a quiet day',
      );
      return;
    }
    // Raw `setInterval` under the lifecycle hooks, matching
    // `MarketWatchService` and `AdaptiveCalibrationService`. `@nestjs/schedule`
    // is deliberately absent repo-wide: it runs a job once per replica, and
    // this one calls a metered quote API per row.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    this.logger.log(`outcome learning ready — tagging up to ${TICK_BATCH} occurrence(s) every ${TICK_MS / 1000}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One scheduled evaluation pass.
   *
   * Public so tests can drive it without waiting on a timer, matching
   * `MarketWatchService.sweep`.
   *
   * Declines outside market hours because every evaluated row costs a live
   * quote, and a quote fetched at 3am prices the pattern at the previous
   * close — which would tag a 15-minute-old occurrence against a price that
   * has not moved since, manufacturing `unclear` outcomes that are artefacts
   * of the clock rather than of the market. The backlog waits; it is not
   * perishable.
   *
   * Never overlaps itself: a pass that outruns its interval must not have a
   * second one stacked on top of it against a rate-limited quote API.
   */
  async tick(at: Date = new Date()): Promise<{ evaluated: number; skipped: 'in-progress' | 'market-closed' | null }> {
    if (this.ticking) return { evaluated: 0, skipped: 'in-progress' };
    if (!isMarketOpen(at)) return { evaluated: 0, skipped: 'market-closed' };

    this.ticking = true;
    try {
      const { evaluated } = await this.evaluatePending(TICK_BATCH);
      this.ticks++;
      this.evaluatedTotal += evaluated;
      if (evaluated > 0) {
        this.logger.log(`tagged ${evaluated} pattern occurrence(s) with an outcome`);
      }
      return { evaluated, skipped: null };
    } finally {
      this.ticking = false;
    }
  }

  /** Scheduler state, for the operator endpoint. */
  status(at: Date = new Date()) {
    return {
      running: this.timer !== null,
      tradingTime: isMarketOpen(at),
      intervalMs: TICK_MS,
      batchSize: TICK_BATCH,
      ticks: this.ticks,
      occurrencesTagged: this.evaluatedTotal,
    };
  }

  async evaluatePending(limit = 5): Promise<{ evaluated: number }> {
    try {
      const cutoff = new Date(Date.now() - OutcomeLearningService.MIN_AGE_MS);
      const rows = await this.prisma.memoryRecord.findMany({
        where: { tags: { has: 'pattern_occurrence' }, namespace: 'sentinel', createdAt: { lte: cutoff } },
        take: limit * 4,
        orderBy: { createdAt: 'asc' },
      });
      const pending = rows
        .map((row) => ({ row, meta: row.metadata as unknown as PatternMetadata | null }))
        .filter((r) => r.meta && r.meta.outcome === null && typeof r.meta.priceAtDetection === 'number')
        .slice(0, limit);

      let evaluated = 0;
      for (const { row, meta } of pending) {
        try {
          const quote = await this.marketData.getQuote(meta!.symbol);
          const movePct = ((quote.lastPrice - meta!.priceAtDetection) / meta!.priceAtDetection) * 100;
          const outcome =
            Math.abs(movePct) < OutcomeLearningService.MOVE_THRESHOLD_PCT
              ? 'unclear'
              : movePct > 0
                ? 'continued_up'
                : 'continued_down';
          await this.memory.update(row.id, {
            metadata: { ...meta, outcome, outcomeMovePct: movePct, outcomeEvaluatedAt: new Date().toISOString() },
          });
          evaluated++;
        } catch (err) {
          this.logger.warn(`could not evaluate outcome for memory ${row.id}: ${err}`);
        }
      }
      return { evaluated };
    } catch (err) {
      this.logger.warn(`outcome evaluation pass failed (non-fatal): ${err}`);
      return { evaluated: 0 };
    }
  }
}

/**
 * How often the tagger runs.
 *
 * Matched to `MarketWatchService`'s sweep interval, because the watch is the
 * writer this exists to keep up with: one tick per sweep means the backlog
 * cannot grow faster than it drains as long as the batch is at least as large
 * as a sweep's output.
 */
const TICK_MS = 60_000;

/**
 * Rows per tick.
 *
 * Each row costs one `getQuote`, served from the bridge's WebSocket-fed tick
 * map rather than the metered Data API, so this is bounded by latency rather
 * than by spend. Twelve matches the watch's symbol cap: a sweep in which every
 * watched symbol fires at once produces at most that many new occurrences, so
 * one tick can always drain one sweep.
 */
const TICK_BATCH = 12;
