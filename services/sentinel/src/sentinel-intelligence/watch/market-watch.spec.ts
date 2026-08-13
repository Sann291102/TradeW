import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketWatchService, validatedSignals } from './market-watch.service';
import { loadSentinelIntelligenceConfig } from '../si.config';
import type { MarketIntelligenceService } from '../../intelligence/market-intelligence.service';
import type { StrategyDetection, StrategyEngineService } from '../../intelligence/strategy-engine.service';
import type { PatternRecognitionService } from '../../brain/pattern-recognition.service';

/**
 * The watch loop is the only part of SentinelIntelligence that spends money
 * without anyone asking it to — it polls a metered API on a timer. These tests
 * pin the three things that keep that safe (it does not run outside trading
 * hours, it does not overlap itself, it does not exceed its symbol cap) and
 * the one thing that keeps its output trustworthy (it does not inflate the
 * base-rate sample the live-performance gate reads).
 *
 * `sweep()` is driven directly. Nothing here waits on a timer.
 */

const config = loadSentinelIntelligenceConfig({});

/** A Tuesday, 11:00 IST — inside the session. */
const TRADING = new Date('2026-08-04T05:30:00.000Z');
/** The Saturday of the same week, 11:00 IST. */
const SATURDAY = new Date('2026-08-08T05:30:00.000Z');
/** Tuesday 20:00 IST — after the close. */
const AFTER_CLOSE = new Date('2026-08-04T14:30:00.000Z');

function detection(strategyId: string, validated = true): StrategyDetection {
  return {
    strategyId,
    strategyName: strategyId.replace(/-/g, ' '),
    confidence: 80,
    bias: 'bullish',
    validated,
    rulesMatched: ['price above ema20'],
    rulesUnmet: [],
    invalidationsTriggered: [],
    source: 'builtin',
  } as unknown as StrategyDetection;
}

function harness(
  opts: {
    detections?: StrategyDetection[];
    snapshotError?: Error;
    patterns?: PatternRecognitionService | null;
    config?: ReturnType<typeof loadSentinelIntelligenceConfig>;
  } = {},
) {
  const record = vi.fn().mockResolvedValue(undefined);
  const snapshot = opts.snapshotError
    ? vi.fn().mockRejectedValue(opts.snapshotError)
    : vi.fn().mockResolvedValue({ lastPrice: 24_300 });
  const scan = vi.fn().mockReturnValue(opts.detections ?? [detection('ema-cross')]);

  const patterns =
    opts.patterns === null ? null : ({ recordOccurrence: record } as unknown as PatternRecognitionService);

  const service = new MarketWatchService(
    opts.config ?? config,
    { snapshot } as unknown as MarketIntelligenceService,
    { scan } as unknown as StrategyEngineService,
    patterns,
  );

  return { service, record, snapshot, scan };
}

describe('the continuous market watch', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('does nothing until a symbol is registered', async () => {
    const result = await h.service.sweep(TRADING);

    expect(result.skipped).toBe('no-symbols');
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('watches a registered symbol and records its validated detections', async () => {
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(result.skipped).toBeNull();
    expect(h.snapshot).toHaveBeenCalledWith('NIFTY');
    expect(result.recorded).toBe(1);
    expect(h.record).toHaveBeenCalledOnce();
  });

  it('records the pattern under the same name the orchestrator uses', async () => {
    h.service.register('NIFTY', TRADING);
    await h.service.sweep(TRADING);

    // `StrategyIntelligenceService.baseRateFor` matches on this exact string —
    // if the two writers disagreed, the gate would read half the evidence.
    expect(h.record.mock.calls[0][1].name).toBe('ema_cross');
    expect(h.record.mock.calls[0][1].triggered).toBe(true);
  });

  it('never records an unvalidated detection', async () => {
    const unvalidated = harness({ detections: [detection('ema-cross', false)] });
    unvalidated.service.register('NIFTY', TRADING);
    const result = await unvalidated.service.sweep(TRADING);

    expect(result.detections).toBe(1);
    expect(result.recorded).toBe(0);
    expect(unvalidated.record).not.toHaveBeenCalled();
  });
});

describe('watch cost controls', () => {
  it('does not sweep outside trading hours', async () => {
    const h = harness();
    h.service.register('NIFTY', AFTER_CLOSE);
    const result = await h.service.sweep(AFTER_CLOSE);

    expect(result.skipped).toBe('market-closed');
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('does not sweep at the weekend, which the shared market clock alone would allow', async () => {
    // `isMarketOpen(SATURDAY)` is true — `market-clock.spec.ts` pins that gap
    // deliberately. The watcher must not inherit it and poll all weekend.
    const h = harness();
    h.service.register('NIFTY', SATURDAY);
    const result = await h.service.sweep(SATURDAY);

    expect(result.skipped).toBe('market-closed');
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('holds the watch list to its cap, dropping the least recently asked for', async () => {
    const capped = loadSentinelIntelligenceConfig({ SI_WATCH_MAX_SYMBOLS: '2' });
    const h = harness({ config: capped });

    h.service.register('NIFTY', new Date(TRADING.getTime()));
    h.service.register('BANKNIFTY', new Date(TRADING.getTime() + 1000));
    h.service.register('FINNIFTY', new Date(TRADING.getTime() + 2000));

    expect(h.service.status(TRADING).watching).toEqual(['BANKNIFTY', 'FINNIFTY']);
  });

  it('stops watching a symbol once its watch lapses', async () => {
    // Pure-TTL mode. With session persistence on (the default) a watch runs to
    // the close instead — see 'the watch does not need a browser' below — so the
    // TTL path is pinned here with persistence explicitly off.
    const ttlOnly = loadSentinelIntelligenceConfig({ SI_WATCH_PERSIST_SESSION: 'false' });
    const h = harness({ config: ttlOnly });
    h.service.register('NIFTY', TRADING);

    const later = new Date(TRADING.getTime() + ttlOnly.watchTtlMs + 1000);
    const result = await h.service.sweep(later);

    expect(h.service.status(later).watching).toEqual([]);
    // Reported as an empty watch list, not as a closed market — the sweep
    // must not misattribute why it did nothing.
    expect(result.skipped).toBe('no-symbols');
  });

  it('falls back to the TTL for a symbol registered outside the session', () => {
    // A watch registered after the close must not be pinned to a session that
    // has already ended, or an after-hours request would hold a symbol
    // overnight and it would be swept the moment tomorrow's bell rang.
    const h = harness();
    h.service.register('NIFTY', AFTER_CLOSE);

    const expiry = new Date(h.service.status(AFTER_CLOSE).watchedUntil.NIFTY).getTime();
    expect(expiry).toBe(AFTER_CLOSE.getTime() + config.watchTtlMs);
  });

  it('never lets a slow sweep stack a second one on top of itself', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const h = harness();
    h.snapshot.mockImplementation(async () => {
      await gate;
      return { lastPrice: 1 };
    });
    h.service.register('NIFTY', TRADING);

    const first = h.service.sweep(TRADING);
    const second = await h.service.sweep(TRADING);
    expect(second.skipped).toBe('in-progress');

    release(null);
    await first;
    expect(h.snapshot).toHaveBeenCalledOnce();
  });

  it('carries on with the remaining symbols when one symbol has no data', async () => {
    const h = harness({ snapshotError: new Error('bridge unavailable') });
    h.service.register('NIFTY', TRADING);
    h.service.register('BANKNIFTY', TRADING);

    const result = await h.service.sweep(TRADING);

    expect(h.snapshot).toHaveBeenCalledTimes(2);
    expect(result.recorded).toBe(0);
  });
});

/**
 * Autonomy. The property that makes this a continuous watch rather than a
 * server-side echo of whoever has a tab open: the loop's inputs must survive the
 * requests that created them.
 */
describe('the watch does not need a browser', () => {
  it('keeps watching after the requests stop, for the rest of the session', async () => {
    // The dashboard polls `/observe` every 45 s, so a plain TTL was refreshed by
    // the tab and retired the symbol `watchTtlMs` after it closed — the browser
    // was the heartbeat. One registration must now carry the session.
    const h = harness();
    h.service.register('NIFTY', TRADING);

    // Well past the TTL, and with nothing having asked about NIFTY since.
    const muchLater = new Date(TRADING.getTime() + config.watchTtlMs * 3);
    const result = await h.service.sweep(muchLater);

    expect(h.service.status(muchLater).watching).toEqual(['NIFTY']);
    expect(result.skipped).toBeNull();
    expect(h.snapshot).toHaveBeenCalledWith('NIFTY');
  });

  it('holds the watch to the close, not beyond it', () => {
    const h = harness();
    h.service.register('NIFTY', TRADING);

    // 15:30 IST on the day of TRADING (2026-08-04) — 10:00 UTC.
    expect(h.service.status(TRADING).watchedUntil.NIFTY).toBe('2026-08-04T10:00:00.000Z');
    expect(h.service.status(TRADING).persistsThroughSession).toBe(true);
  });

  it('no longer reports no-symbols once a symbol has been observed', async () => {
    // The exact production symptom: watching [], sweeps 0, lastSweepAt null all
    // day, because nothing on the `/observe` path ever registered anything.
    const h = harness();
    expect((await h.service.sweep(TRADING)).skipped).toBe('no-symbols');

    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(new Date(TRADING.getTime() + 60_000));

    expect(result.skipped).toBeNull();
    expect(result.symbols).toBe(1);
    const status = h.service.status(TRADING);
    expect(status.sweeps).toBeGreaterThan(0);
    expect(status.lastSweepAt).not.toBeNull();
    expect(status.lastSkipReason).toBeNull();
  });

  it('reports that it ticked even when it had nothing to do', async () => {
    // `lastSweepAt` alone cannot distinguish a dead loop from an idle one, and
    // that ambiguity is what let a watch that had never swept look healthy.
    const h = harness();
    const result = await h.service.sweep(TRADING);

    expect(result.skipped).toBe('no-symbols');
    expect(h.service.status(TRADING).lastTickAt).toBe(TRADING.toISOString());
    expect(h.service.status(TRADING).lastSweepAt).toBeNull();
    expect(h.service.status(TRADING).lastSkipReason).toBe('no-symbols');
  });

  it('still refuses to sweep after the close even while a watch is technically live', async () => {
    // Session persistence must never become a licence to poll a metered API
    // after hours. A watch registered near the bell keeps its TTL floor, which
    // outlives the session — so the trading-time guard, not the expiry, has to
    // be what stops the sweep. Two independent controls, both required.
    const h = harness();
    const nearClose = new Date('2026-08-04T09:59:00.000Z'); // 15:29 IST
    h.service.register('NIFTY', nearClose);

    const afterBell = new Date('2026-08-04T10:05:00.000Z'); // 15:35 IST
    const result = await h.service.sweep(afterBell);

    expect(h.service.status(afterBell).watching).toEqual(['NIFTY']);
    expect(result.skipped).toBe('market-closed');
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('lets a session-held watch lapse at the close rather than carrying it overnight', async () => {
    const h = harness();
    h.service.register('NIFTY', TRADING);

    const nextMorning = new Date('2026-08-05T04:00:00.000Z'); // 09:30 IST, Wednesday
    const result = await h.service.sweep(nextMorning);

    // Tomorrow starts from an empty list and fills from real observations again.
    expect(h.service.status(nextMorning).watching).toEqual([]);
    expect(result.skipped).toBe('no-symbols');
  });
});

describe('base-rate integrity', () => {
  it('does not re-record the same setup on every tick', async () => {
    // The load-bearing one. A setup stays valid across consecutive ticks; if
    // each tick counted, one setup that persisted an hour would look like
    // dozens of independent occurrences and make an unproven pattern read as
    // proven to the live-performance gate.
    const h = harness();
    h.service.register('NIFTY', TRADING);

    await h.service.sweep(TRADING);
    await h.service.sweep(new Date(TRADING.getTime() + 60_000));
    await h.service.sweep(new Date(TRADING.getTime() + 120_000));

    expect(h.record).toHaveBeenCalledOnce();
  });

  it('records again once the cooldown has passed', async () => {
    const h = harness();
    h.service.register('NIFTY', TRADING);

    await h.service.sweep(TRADING);
    const afterCooldown = new Date(TRADING.getTime() + config.watchRecordCooldownMs + 1000);
    h.service.register('NIFTY', afterCooldown);
    await h.service.sweep(afterCooldown);

    expect(h.record).toHaveBeenCalledTimes(2);
  });

  it('cools down per symbol, not globally', async () => {
    const h = harness();
    h.service.register('NIFTY', TRADING);
    h.service.register('BANKNIFTY', TRADING);

    const result = await h.service.sweep(TRADING);

    expect(result.recorded).toBe(2);
  });

  it('reports honestly when it has no way to record', async () => {
    const h = harness({ patterns: null });
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(h.service.status(TRADING).recording).toBe(false);
    expect(result.detections).toBe(1);
    expect(result.recorded).toBe(0);
  });
});

describe('watch configuration', () => {
  it('refuses to poll faster than the bridge candle cache', () => {
    // Below 60s every extra poll returns the identical cached body.
    expect(loadSentinelIntelligenceConfig({ SI_WATCH_INTERVAL_MS: '1000' }).watchIntervalMs).toBe(60_000);
  });

  it('is on by default and opt-out', () => {
    expect(loadSentinelIntelligenceConfig({}).watchEnabled).toBe(true);
    expect(loadSentinelIntelligenceConfig({ SI_WATCH_ENABLED: 'false' }).watchEnabled).toBe(false);
    expect(loadSentinelIntelligenceConfig({ SI_WATCH_ENABLED: 'nonsense' }).watchEnabled).toBe(true);
  });

  it('persists a watch through the session by default, and is opt-out too', () => {
    // A config typo must not quietly hand the heartbeat back to the browser.
    expect(loadSentinelIntelligenceConfig({}).watchPersistThroughSession).toBe(true);
    expect(
      loadSentinelIntelligenceConfig({ SI_WATCH_PERSIST_SESSION: 'false' }).watchPersistThroughSession,
    ).toBe(false);
    expect(
      loadSentinelIntelligenceConfig({ SI_WATCH_PERSIST_SESSION: 'nonsense' }).watchPersistThroughSession,
    ).toBe(true);
  });

  it('warms the corpus at boot by default, so background reasoning is not gated on a manual call', () => {
    expect(loadSentinelIntelligenceConfig({}).indexOnBoot).toBe(true);
    expect(loadSentinelIntelligenceConfig({ SI_INDEX_ON_BOOT: 'false' }).indexOnBoot).toBe(false);
  });

  it('registers nothing while disabled', () => {
    const off = loadSentinelIntelligenceConfig({ SI_WATCH_ENABLED: 'false' });
    const h = harness({ config: off });
    h.service.register('NIFTY', TRADING);

    expect(h.service.status(TRADING).watching).toEqual([]);
  });
});

/**
 * Continuous reasoning. The trigger policy is the whole design: reason when
 * the picture *changes*, not on every tick, and never let the cost bound
 * silently swallow a symbol.
 */
describe('reasoning on what the watch finds', () => {
  function withReasoner(opts: Parameters<typeof harness>[0] = {}) {
    const h = harness(opts);
    const reason = vi.fn().mockResolvedValue({ runId: 'run-1' });
    h.service.setReasoner(reason);
    return { ...h, reason };
  }

  it('reasons when a new setup is found', async () => {
    const h = withReasoner();
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(h.reason).toHaveBeenCalledOnce();
    expect(result.reasoned).toBe(1);
  });

  it('reasons over the snapshot the sweep already pulled, not a fresh one', async () => {
    // The snapshot is the only metered part of a run. Reusing it is what makes
    // background reasoning free at the data layer — and stops the detection
    // and the reasoning about it reading different ticks.
    const h = withReasoner();
    h.service.register('NIFTY', TRADING);
    await h.service.sweep(TRADING);

    expect(h.snapshot).toHaveBeenCalledOnce();
    expect(h.reason.mock.calls[0][1]).toEqual({ lastPrice: 24_300 });
  });

  it('does not re-reason an unchanged picture on every tick', async () => {
    const h = withReasoner();
    h.service.register('NIFTY', TRADING);

    await h.service.sweep(TRADING);
    await h.service.sweep(new Date(TRADING.getTime() + 60_000));
    await h.service.sweep(new Date(TRADING.getTime() + 120_000));

    // Same setup still valid, nothing new recorded — nothing new to say.
    expect(h.reason).toHaveBeenCalledOnce();
  });

  it('does not reason when nothing validated', async () => {
    const h = withReasoner({ detections: [detection('ema-cross', false)] });
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(h.reason).not.toHaveBeenCalled();
    expect(result.reasoned).toBe(0);
  });

  it('bounds reasoning per sweep so a busy open cannot overrun the interval', async () => {
    const capped = loadSentinelIntelligenceConfig({ SI_WATCH_MAX_REASONING_PER_SWEEP: '2' });
    const h = withReasoner({ config: capped });
    h.service.register('NIFTY', TRADING);
    h.service.register('BANKNIFTY', TRADING);
    h.service.register('FINNIFTY', TRADING);

    const result = await h.service.sweep(TRADING);

    expect(h.reason).toHaveBeenCalledTimes(2);
    expect(result.reasoned).toBe(2);
    // The third was recorded — only the reasoning about it was deferred.
    expect(result.recorded).toBe(3);
    expect(h.service.status(TRADING).reasoningDeferred).toBe(1);
  });

  it('still records occurrences when reasoning is switched off', async () => {
    const off = loadSentinelIntelligenceConfig({ SI_WATCH_REASON_ENABLED: 'false' });
    const h = withReasoner({ config: off });
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(h.reason).not.toHaveBeenCalled();
    expect(result.recorded).toBe(1);
    expect(h.service.status(TRADING).reasoning).toBe(false);
  });

  it('reports honestly when no reasoner has been wired', async () => {
    const h = harness();
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(h.service.status(TRADING).reasoning).toBe(false);
    expect(result.recorded).toBe(1);
    expect(result.reasoned).toBe(0);
  });

  it('counts a declined run as not reasoned, and carries on', async () => {
    // The reasoner returns null on a cold corpus rather than triggering a
    // 194-document ingest from inside a timer.
    const h = withReasoner();
    h.reason.mockResolvedValue(null);
    h.service.register('NIFTY', TRADING);
    const result = await h.service.sweep(TRADING);

    expect(result.reasoned).toBe(0);
    expect(result.recorded).toBe(1);
  });
});

describe('validatedSignals', () => {
  it('keeps only validated detections and normalises the strategy id', () => {
    const signals = validatedSignals([
      detection('opening-range-break'),
      detection('vwap-reversion', false),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0].name).toBe('opening_range_break');
    expect(signals[0].agent).toBe('strategy');
  });

  it('scales confidence into the 0..1 signal weight space', () => {
    expect(validatedSignals([detection('ema-cross')])[0].weight).toBeCloseTo(0.4);
  });
});
