import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { Signal } from '../../domain';
import { MarketIntelligenceService, type MarketSnapshot } from '../../intelligence/market-intelligence.service';
import { StrategyEngineService, type StrategyDetection } from '../../intelligence/strategy-engine.service';
import { PatternRecognitionService } from '../../brain/pattern-recognition.service';
import { isMarketOpen } from '../../market-clock';
import { SI_CONFIG, SentinelIntelligenceConfig } from '../si.config';

/**
 * Continuous market watch.
 *
 * SentinelIntelligence answers one request at a time. That is correct for
 * reasoning, and wrong for *noticing*: a setup that forms at 11:04 and
 * resolves by 11:20 never existed as far as the engine was concerned unless a
 * trader happened to refresh during it. This service is the part that watches
 * whether or not anyone is looking.
 *
 * What it does per tick, per watched symbol: pull the live snapshot, run the
 * strategy engine over it — the same declarative, book-derived rules the
 * request path uses — and record every validated detection to the Brain.
 *
 * What it deliberately does NOT do: run the ten reasoning agents. Ten agents
 * against the BM25 corpus, per symbol, per tick, would cost orders of
 * magnitude more than the detection itself and produce reasoning nobody
 * requested. Detection is continuous; reasoning stays on demand.
 *
 * ## Why polling, and not a WebSocket
 *
 * `packages/market-data` has a real `DhanMarketFeed`, and `services/market-data`
 * already runs it. That is exactly why Sentinel must not open its own: Dhan
 * allows **5 WebSocket connections per account** and evicts the oldest with
 * code 805, and `services/market-data`'s README declares the ingestor a
 * singleton for that reason. A second consumer here would compete for that
 * budget and could evict the running ingestor — trading a read-only
 * convenience for a production outage in the service that feeds everything.
 *
 * The push feed already exists one hop away. The bridge's `GET /quotes` is
 * served straight from its WebSocket-fed in-memory tick map — no upstream
 * call, no rate limit — so polling it reads genuinely push-fed live ticks
 * without becoming a sixth connection. `GET /candles` is the metered path
 * (Dhan's charged Data API, 5 req/s, behind a 60 s bridge cache), which is
 * what the interval floor and the symbol cap below exist to respect.
 */
@Injectable()
export class MarketWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketWatchService.name);

  /** symbol → when its watch expires. */
  private readonly watched = new Map<string, number>();
  /** `symbol::pattern` → when it may next be recorded. */
  private readonly cooldowns = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private stopping = false;
  private lastSweepAt: Date | null = null;
  private sweeps = 0;
  private recorded = 0;
  private reasonedRuns = 0;
  private reasoningSkipped = 0;
  private reasoner: WatchReasoner | null = null;

  constructor(
    @Inject(SI_CONFIG) private readonly config: SentinelIntelligenceConfig,
    private readonly market: MarketIntelligenceService,
    private readonly strategies: StrategyEngineService,
    /**
     * The Brain writer.
     *
     * Optional only so the standalone `SentinelIntelligenceModule` — a
     * test-only definition — need not pull in `ConceptLearningEngine` and its
     * `ProviderManager`/`KnowledgeGraph` chain. `AppModule`, the sole
     * production path, always provides it. When it is absent the watch still
     * observes but records nothing, and says so at boot and in `status()`
     * rather than looking healthy while writing no track record.
     */
    @Optional() private readonly patterns: PatternRecognitionService | null,
  ) {}

  onModuleInit(): void {
    if (!this.config.watchEnabled) {
      this.logger.log('market watch disabled (SI_WATCH_ENABLED=false)');
      return;
    }
    if (!this.patterns) {
      this.logger.warn(
        'market watch has no PatternRecognitionService — it will observe but record no occurrences, ' +
          'so the live-performance gate will never accumulate evidence',
      );
    }
    // Raw `setInterval` under the lifecycle hooks, matching
    // `IngestionQueueService`. `@nestjs/schedule` is deliberately absent from
    // this service: `docs/handbook/09-sentinel-runtime.md` warns it runs the
    // job once per replica, and a metered data API is the wrong place to
    // discover that.
    this.timer = setInterval(() => void this.sweep(), this.config.watchIntervalMs);
    this.logger.log(
      `market watch ready — interval=${this.config.watchIntervalMs}ms maxSymbols=${this.config.watchMaxSymbols} ` +
        `ttl=${this.config.watchTtlMs}ms cooldown=${this.config.watchRecordCooldownMs}ms`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Put a symbol under watch, or extend the watch already on it.
   *
   * Called from the request path, so the watch list is exactly the set of
   * charts traders actually have on their board — not a sweep of the ~219
   * selectable symbols, which would spend the Dhan candle budget almost
   * entirely on instruments nobody is looking at.
   *
   * The watch lapses `watchTtlMs` after the last request for that symbol, so a
   * board that is closed stops costing anything without needing an explicit
   * unregister that a crashed tab would never send.
   */
  register(symbol: string, at: Date = new Date()): void {
    if (!this.config.watchEnabled || !symbol) return;
    const key = symbol.toUpperCase();
    const wasWatching = this.watched.has(key);

    this.watched.set(key, at.getTime() + this.config.watchTtlMs);
    if (!wasWatching) this.logger.log(`watching ${key} (${this.watched.size} under watch)`);

    this.evictOldest(at);
  }

  /**
   * One pass over every watched symbol.
   *
   * Public so tests can drive it directly — a background loop that can only be
   * exercised by waiting on a timer is a background loop nobody tests.
   */
  async sweep(at: Date = new Date()): Promise<WatchSweepResult> {
    // A sweep that overruns its interval must not have a second one stacked on
    // top of it: that is how a slow bridge turns into unbounded concurrency
    // against a rate-limited API.
    if (this.sweeping || this.stopping) return { skipped: 'in-progress', symbols: 0, detections: 0, recorded: 0, reasoned: 0 };

    // Expire first, so a sweep is never judged against symbols that have
    // already lapsed, and the skip reason below is the true one.
    this.expire(at);
    if (this.watched.size === 0) return { skipped: 'no-symbols', symbols: 0, detections: 0, recorded: 0, reasoned: 0 };
    if (!this.isTradingTime(at)) return { skipped: 'market-closed', symbols: 0, detections: 0, recorded: 0, reasoned: 0 };

    this.sweeping = true;
    const symbols = [...this.watched.keys()];

    let detections = 0;
    let recorded = 0;
    let reasoned = 0;
    // Bounds how much reasoning one sweep may do, so a morning where every
    // watched symbol fires at once cannot push the sweep past its own
    // interval. What is dropped is logged, never silently skipped.
    const budget = { reasoningLeft: this.config.watchMaxReasoningPerSweep };
    try {
      // Sequential on purpose. Each symbol costs two `/candles` calls against
      // Dhan's 5 req/s ceiling, and a `Promise.all` over a dozen symbols would
      // breach it in a burst for no latency benefit — nothing is waiting on
      // this sweep.
      for (const symbol of symbols) {
        if (this.stopping) break;
        const result = await this.watchOne(symbol, at, budget);
        detections += result.detections;
        recorded += result.recorded;
        if (result.reasoned) reasoned++;
      }
    } finally {
      this.sweeping = false;
      this.lastSweepAt = at;
      this.sweeps++;
      this.recorded += recorded;
    }

    if (recorded > 0) {
      this.logger.log(
        `sweep recorded ${recorded} occurrence(s) across ${symbols.length} symbol(s), reasoned about ${reasoned}`,
      );
    }
    return { skipped: null, symbols: symbols.length, detections, recorded, reasoned };
  }

  /**
   * Register the engine that reasons about what the watch finds.
   *
   * A setter rather than constructor injection: the reasoning service already
   * depends on this one, so injecting it back would be a DI cycle. See
   * `SentinelIntelligenceService.onModuleInit`.
   */
  setReasoner(reasoner: WatchReasoner): void {
    this.reasoner = reasoner;
  }

  /** Snapshot one symbol, scan it, record what validated. */
  private async watchOne(
    symbol: string,
    at: Date,
    budget: { reasoningLeft: number },
  ): Promise<{ detections: number; recorded: number; reasoned: boolean }> {
    let detections: StrategyDetection[];
    let snapshot: Awaited<ReturnType<MarketIntelligenceService['snapshot']>>;
    let lastPrice: number;

    try {
      snapshot = await this.market.snapshot(symbol);
      detections = this.strategies.scan(snapshot, at);
      lastPrice = snapshot.lastPrice;
    } catch (err) {
      // A data outage on one symbol must not abort the sweep — the other
      // watched symbols may be fine, and the next tick retries anyway.
      this.logger.warn(`watch skipped ${symbol}: ${(err as Error).message}`);
      return { detections: 0, recorded: 0, reasoned: false };
    }

    let recorded = 0;
    if (this.patterns) {
      for (const signal of validatedSignals(detections)) {
        if (!this.claimCooldown(symbol, signal.name, at)) continue;
        await this.patterns.recordOccurrence(symbol, signal, lastPrice);
        recorded++;
      }
    }

    // Reason only on a setup that is *new* — one that just cleared its
    // cooldown. A validated setup stays valid for many consecutive sweeps, and
    // re-reasoning an unchanged picture every minute would burn CPU to
    // reproduce the same verdicts.
    //
    // Note what is deliberately NOT checked here: whether the pattern has live
    // performance. Pre-filtering on that would be free cost savings for
    // directional reads and a silent hole for risk warnings, which are exempt
    // from that gate precisely because they matter without a track record.
    const shouldReason =
      this.config.watchReasonEnabled && recorded > 0 && this.reasoner !== null && budget.reasoningLeft > 0;

    if (!shouldReason) {
      if (this.config.watchReasonEnabled && recorded > 0 && budget.reasoningLeft <= 0) {
        this.reasoningSkipped++;
        this.logger.log(`reasoning budget spent this sweep — ${symbol} not reasoned about (will retry next sweep)`);
      }
      return { detections: detections.length, recorded, reasoned: false };
    }

    budget.reasoningLeft--;
    const run = await this.reasoner!(symbol, snapshot, at);
    if (run) this.reasonedRuns++;
    return { detections: detections.length, recorded, reasoned: run !== null };
  }

  /**
   * Reserve the right to record this pattern, or decline.
   *
   * Base-rate integrity depends on this. The same setup stays valid across
   * many consecutive ticks, and the orchestrator writes to the same store on
   * every `/observe`, so without a cooldown one setup that persisted for an
   * hour would be counted as dozens of independent occurrences — inflating
   * exactly the sample the live-performance gate reads and making an unproven
   * pattern look proven.
   *
   * The window matches `OutcomeLearningService.MIN_AGE_MS`: a pattern may be
   * recorded again once the previous occurrence is old enough to have been
   * outcome-tagged, so every counted occurrence is one that could resolve
   * independently.
   */
  private claimCooldown(symbol: string, pattern: string, at: Date): boolean {
    const key = `${symbol}::${pattern}`;
    const until = this.cooldowns.get(key);
    if (until !== undefined && at.getTime() < until) return false;
    this.cooldowns.set(key, at.getTime() + this.config.watchRecordCooldownMs);
    return true;
  }

  /**
   * Trading time, including the weekday check `market-clock.ts` does not do.
   *
   * `isMarketOpen()` is time-of-day only — it returns true at 11:00 on a
   * Sunday, a gap `market-clock.spec.ts` pins deliberately because seven
   * services key off the current semantics. Fixing it there is the
   * clock-unification change and is out of scope here; leaving it unhandled
   * would mean sweeping the metered candle API every weekend, so the weekday
   * check lives locally and additively until that lands.
   *
   * Still holiday-blind. An NSE holiday sweeps and finds nothing, which costs
   * cached calls rather than producing wrong data.
   */
  private isTradingTime(at: Date): boolean {
    if (!this.config.watchEnabled) return false;
    const istDay = new Date(at.getTime() + IST_OFFSET_MS).getUTCDay();
    if (istDay === 0 || istDay === 6) return false;
    return isMarketOpen(at);
  }

  /** Drop symbols whose watch has lapsed, and stale cooldown entries with them. */
  private expire(at: Date): void {
    const now = at.getTime();
    for (const [symbol, expiresAt] of this.watched) {
      if (expiresAt <= now) {
        this.watched.delete(symbol);
        this.logger.log(`watch lapsed for ${symbol}`);
      }
    }
    for (const [key, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(key);
    }
  }

  /**
   * Hold the watch list to its cap, dropping whichever symbol goes stale
   * soonest — that is the one least recently asked for.
   */
  private evictOldest(at: Date): void {
    while (this.watched.size > this.config.watchMaxSymbols) {
      let oldest: string | null = null;
      let oldestExpiry = Infinity;
      for (const [symbol, expiresAt] of this.watched) {
        if (expiresAt < oldestExpiry) {
          oldestExpiry = expiresAt;
          oldest = symbol;
        }
      }
      if (!oldest) break;
      this.watched.delete(oldest);
      this.logger.log(`watch cap reached — dropped ${oldest}`);
    }
    void at;
  }

  /** Watch state, for the operator endpoint. */
  status(at: Date = new Date()) {
    return {
      enabled: this.config.watchEnabled,
      running: this.timer !== null,
      /** False means detections are observed but never written to the Brain. */
      recording: this.patterns !== null,
      tradingTime: this.isTradingTime(at),
      watching: [...this.watched.keys()],
      maxSymbols: this.config.watchMaxSymbols,
      intervalMs: this.config.watchIntervalMs,
      sweeps: this.sweeps,
      occurrencesRecorded: this.recorded,
      /** False means setups are detected and recorded, but never reasoned about. */
      reasoning: this.config.watchReasonEnabled && this.reasoner !== null,
      reasoningRuns: this.reasonedRuns,
      /** Sweeps that found a new setup but had no reasoning budget left. */
      reasoningDeferred: this.reasoningSkipped,
      lastSweepAt: this.lastSweepAt?.toISOString() ?? null,
    };
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface WatchSweepResult {
  /** Why the sweep did nothing, or null when it ran. */
  skipped: 'in-progress' | 'market-closed' | 'no-symbols' | null;
  symbols: number;
  detections: number;
  recorded: number;
  /** Symbols this sweep ran the full reasoning pipeline on. */
  reasoned: number;
}

/**
 * What the watch calls when it finds a new setup.
 *
 * Takes the snapshot the sweep already pulled, so the reasoning run costs no
 * additional metered HTTP and cannot disagree with the detection that
 * triggered it by reading a different tick. Returns null when the run was
 * declined — a cold corpus, or a failure that must not stop the sweep.
 */
export type WatchReasoner = (
  symbol: string,
  snapshot: MarketSnapshot | null,
  at: Date,
) => Promise<unknown | null>;

/**
 * Validated detections as recordable signals.
 *
 * The name derivation (`strategyId` with dashes as underscores) is copied
 * deliberately from the orchestrator's `strategySignals`, because
 * `StrategyIntelligenceService.baseRateFor` matches on that exact string. If
 * the two writers named the same setup differently, the live-performance gate
 * would read half the evidence and never say so.
 */
export function validatedSignals(detections: StrategyDetection[]): Signal[] {
  return detections
    .filter((d) => d.validated)
    .map((d) => ({
      name: d.strategyId.replace(/-/g, '_'),
      agent: 'strategy' as const,
      triggered: true,
      weight: Math.min(0.5, d.confidence / 200),
      evidence: [
        `${d.strategyName} (${d.bias} side): ${d.rulesMatched.length}/${d.rulesMatched.length + d.rulesUnmet.length} rules confirmed`,
        ...d.rulesMatched,
      ],
      data: { strategyId: d.strategyId, bias: d.bias, validated: d.validated, source: d.source, via: 'market-watch' },
    }));
}
