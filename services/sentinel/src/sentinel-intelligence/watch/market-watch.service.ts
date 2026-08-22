import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { Signal } from '../../domain';
import { MarketIntelligenceService, type MarketSnapshot } from '../../intelligence/market-intelligence.service';
import { StrategyEngineService, type StrategyDetection } from '../../intelligence/strategy-engine.service';
import { PatternRecognitionService } from '../../brain/pattern-recognition.service';
import { MARKET_CLOSE_MIN, isMarketOpen, istMinutesOfDay } from '../../market-clock';
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
 * It also reasons, but only on a setup that is NEW — one that just cleared its
 * record cooldown — and at most `watchMaxReasoningPerSweep` symbols per sweep.
 * Running ten agents against the corpus for every symbol on every tick would
 * cost orders of magnitude more than the detection and would mostly reproduce
 * the previous minute's verdicts about an unchanged picture.
 *
 * The watch list is seeded at boot from `watchSeedSymbols` and extended by
 * `register()` from the request path. The seed is what makes "watches whether
 * or not anyone is looking" literally true: without it the list was empty on a
 * fresh deployment and stayed empty until a human asked about something.
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
  /**
   * Every tick, including the ones that did nothing.
   *
   * Separate from `lastSweepAt` because they answer different questions, and
   * conflating them hid a real fault for a whole trading day: `lastSweepAt` was
   * null and `sweeps` was 0, which reads identically whether the loop is dead
   * or alive-but-idle. This one is the liveness proof.
   */
  private lastTickAt: Date | null = null;
  private lastSkip: WatchSweepResult['skipped'] = null;
  private sweeps = 0;
  private recorded = 0;
  private reasonedRuns = 0;
  private reasoningSkipped = 0;
  private reasoner: WatchReasoner | null = null;
  /** Symbols seeded at boot, reported in `status()` so the seed is checkable. */
  private readonly seeded: string[] = [];

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
    this.seed();

    // Raw `setInterval` under the lifecycle hooks, matching
    // `IngestionQueueService`. `@nestjs/schedule` is deliberately absent from
    // this service: `docs/handbook/09-sentinel-runtime.md` warns it runs the
    // job once per replica, and a metered data API is the wrong place to
    // discover that.
    this.timer = setInterval(() => void this.sweep(), this.config.watchIntervalMs);
    this.logger.log(
      `market watch ready — interval=${this.config.watchIntervalMs}ms maxSymbols=${this.config.watchMaxSymbols} ` +
        `ttl=${this.config.watchTtlMs}ms cooldown=${this.config.watchRecordCooldownMs}ms ` +
        `seeded=${this.seeded.length ? this.seeded.join('/') : 'none'}`,
    );
  }

  /**
   * Put the configured default universe under watch at boot.
   *
   * This is what makes the system self-starting. `register()` is only reachable
   * from a request, so before this the watch list was empty on a fresh
   * deployment, every sweep exited at the `no-symbols` guard, the nine
   * autonomous agents never ran, and `PatternRecognitionService` recorded
   * nothing — which starved the base rates that gate 4 reads, which meant a
   * directional read could never surface, which meant nothing ever gave a
   * trader a reason to open the app. A deadlock that fed itself.
   *
   * Seeded symbols are ordinary watch entries, not privileged ones. They
   * expire on the same rule as any other (`expiryFor`), they are evicted by the
   * same cap, and they cost nothing outside trading hours because `sweep()`
   * declines with `market-closed` before touching the data API. Registering
   * outside a session gives them the plain TTL, so a service restarted at
   * 2am does not hold them overnight — the next boot inside a session seeds
   * them again.
   *
   * Public, and takes `at`, for the same reason `sweep()` is: a boot-time
   * behaviour that can only be exercised by booting is a behaviour nobody
   * tests. Production calls it with no argument from `onModuleInit`.
   */
  seed(at: Date = new Date()): void {
    for (const symbol of this.config.watchSeedSymbols) {
      this.register(symbol, at);
      // `register` is idempotent; this list must be too, or a second call
      // would report a doubled seed to an operator reading `status()`.
      if (this.config.watchEnabled && !this.seeded.includes(symbol)) this.seeded.push(symbol);
    }
    if (this.seeded.length === 0) {
      this.logger.warn(
        'no seed symbols configured (SI_WATCH_SEED_SYMBOLS is empty) — the watch stays idle until a request ' +
          'registers a symbol, and the live-performance gate accumulates no evidence until then',
      );
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Put a symbol under watch, or extend the watch already on it.
   *
   * Called from the request path — `/observe` and `/intelligence/reason` — so
   * the watch list is the configured seed universe plus exactly the charts
   * traders actually have on their board, not a sweep of the ~219 selectable
   * symbols, which would spend the Dhan candle budget almost entirely on
   * instruments nobody is looking at.
   *
   * Idempotent: re-registering an already-watched symbol only moves its expiry,
   * so the 45 s dashboard poll creates one watcher, not one per request, and
   * the single sweep loop started in `onModuleInit` remains the only timer in
   * the service.
   */
  register(symbol: string, at: Date = new Date()): void {
    if (!this.config.watchEnabled || !symbol) return;
    const key = symbol.toUpperCase();
    const wasWatching = this.watched.has(key);

    this.watched.set(key, this.expiryFor(at));
    if (!wasWatching) this.logger.log(`watching ${key} (${this.watched.size} under watch)`);

    this.evictOldest(at);
  }

  /**
   * When a watch registered now should lapse.
   *
   * The plain TTL made the browser the heartbeat. The dashboard polls
   * `/observe` every 45 s, so an open tab refreshed the TTL forever and a
   * closed one retired the symbol `watchTtlMs` later — meaning "continuous
   * watch" in practice meant "watched while somebody is looking", which is the
   * precise thing this service exists not to be.
   *
   * Holding a watch to the close instead means a chart somebody opened today
   * keeps being observed for the rest of today's session whether or not their
   * tab is still open. It stays bounded by the two things that actually cost
   * money, both unchanged: a sweep is a no-op outside trading hours
   * (`isTradingTime`), and the symbol cap still applies. Registering outside the
   * session falls back to the TTL, so a pre-market or after-hours request
   * cannot pin a symbol overnight, and nothing carries into tomorrow — the next
   * session starts from an empty list and fills from real observations again.
   */
  private expiryFor(at: Date): number {
    const ttlExpiry = at.getTime() + this.config.watchTtlMs;
    if (!this.config.watchPersistThroughSession) return ttlExpiry;
    // Minutes-to-close from the shared IST clock rather than local date maths,
    // so this cannot disagree with the guard that decides whether to sweep.
    const msToClose = (MARKET_CLOSE_MIN - istMinutesOfDay(at)) * 60_000;
    return Math.max(ttlExpiry, at.getTime() + msToClose);
  }

  /**
   * One pass over every watched symbol.
   *
   * Public so tests can drive it directly — a background loop that can only be
   * exercised by waiting on a timer is a background loop nobody tests.
   */
  async sweep(at: Date = new Date()): Promise<WatchSweepResult> {
    // Recorded before any guard, so an operator can tell a loop that is idle
    // from a loop that is dead. Everything below can legitimately decline.
    this.lastTickAt = at;

    // A sweep that overruns its interval must not have a second one stacked on
    // top of it: that is how a slow bridge turns into unbounded concurrency
    // against a rate-limited API.
    if (this.sweeping || this.stopping) return this.declined('in-progress');

    // Expire first, so a sweep is never judged against symbols that have
    // already lapsed, and the skip reason below is the true one.
    this.expire(at);
    if (this.watched.size === 0) return this.declined('no-symbols');
    if (!this.isTradingTime(at)) return this.declined('market-closed');

    this.lastSkip = null;
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

  /** A tick that legitimately did no work, remembered so `status()` can say why. */
  private declined(reason: Exclude<WatchSweepResult['skipped'], null>): WatchSweepResult {
    this.lastSkip = reason;
    return { skipped: reason, symbols: 0, detections: 0, recorded: 0, reasoned: 0 };
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
   * Trading time — a real NSE session, now including holidays.
   *
   * This used to carry its own weekday check because `isMarketOpen()` was
   * time-of-day only and returned true at 11:00 on a Sunday. It was additive
   * and local, explicitly "until clock-unification lands". That landed on
   * 2026-08-16: `market-clock.ts` reads the shared NSE calendar in
   * `@tradew/market-data`, so `isMarketOpen` is false on weekends AND on
   * holidays, and the local `getUTCDay()` arithmetic is gone rather than left
   * as a second, weaker copy of the same rule.
   *
   * The holiday half is the part that was actually costing something: an NSE
   * holiday is a weekday, so the old check let every sweep through and spent
   * metered Dhan calls on a market that never opened.
   */
  private isTradingTime(at: Date): boolean {
    if (!this.config.watchEnabled) return false;
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
      /**
       * The boot seed. An empty array with an empty `watching` is the
       * cold-start deadlock this service used to sit in permanently; the two
       * fields together say whether that is configuration or a fault.
       */
      seeded: [...this.seeded],
      /** symbol → when its watch lapses, so "watched until the close" is checkable. */
      watchedUntil: Object.fromEntries(
        [...this.watched].map(([symbol, expiresAt]) => [symbol, new Date(expiresAt).toISOString()]),
      ),
      /** False means a watch retires `watchTtlMs` after the last request instead. */
      persistsThroughSession: this.config.watchPersistThroughSession,
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
      /** The last time the loop ticked at all, whether or not it swept. */
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      /** Why the most recent tick did nothing, or null when it swept. */
      lastSkipReason: this.lastSkip,
    };
  }
}

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
