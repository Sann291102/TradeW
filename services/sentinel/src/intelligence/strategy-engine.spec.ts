import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { StrategyEngineService } from './strategy-engine.service';
import { latestBarAt, type MarketSnapshot } from './market-intelligence.service';

/**
 * Detection timestamps.
 *
 * `detectedAt` used to be the scan's own clock, which on the `/observe` path is
 * a browser poll. Every setup on a session timeline therefore carried the time
 * of the last refresh rather than the time of the market event, so a chart
 * opened at 14:59 showed three setups "detected" at 14:59 no matter which bars
 * they had actually formed on. These tests pin the distinction the session
 * narrative depends on: `detectedAt` is market time, `observedAt` is execution
 * time, and the scan clock is never silently substituted for the former while
 * bars exist to say otherwise.
 *
 * `onModuleInit` is deliberately not called — that reads user YAML off disk, and
 * these assertions are about the built-in handbook only.
 */

/** A Tuesday, 15:00 IST — long after the bars below, as a stale poll would be. */
const SCAN_CLOCK = new Date('2026-08-04T09:30:00.000Z');

function bar(iso: string, volume = 1_000): Candle {
  return { timestamp: new Date(iso), open: 200, high: 201, low: 199, close: 200, volume };
}

/**
 * The smallest snapshot that produces a detection: EMA20 above EMA50 confirms
 * one rule of `ema-cross-bounce`, which has no ideal-session window, so the scan
 * clock cannot gate it out. Price sits far from the confluence and the bars
 * carry no volume baseline, so the other two rules stay unmet — a *forming*
 * setup, which is still a detection and still needs a truthful timestamp.
 */
function snapshot(bars: Candle[], sessionBars: Candle[] = bars): MarketSnapshot {
  return {
    symbol: 'NIFTY',
    lastPrice: 200,
    rsi14: null,
    ema20: 100,
    ema50: 99,
    vwap: null,
    macdHistogram: null,
    cpr: null,
    volumeVsAvg: null,
    oiTrend: 'unknown',
    realizedVolPct: null,
    vix: null,
    breadthRatio: null,
    support: null,
    resistance: null,
    candles: bars,
    sessionCandles: sessionBars,
    priorDay: null,
    marketProfile: null,
    trendAnalysis: null,
    openingRange: null,
    optionChain: null,
  };
}

function scanOnce(bars: Candle[], at: Date = SCAN_CLOCK, sessionBars?: Candle[]) {
  const detections = new StrategyEngineService().scan(snapshot(bars, sessionBars ?? bars), at);
  expect(detections.length).toBeGreaterThan(0);
  return detections[0];
}

describe('detection timestamps', () => {
  it('stamps a detection with the bar its rules matched on, not the scan clock', () => {
    const detection = scanOnce([bar('2026-08-04T04:00:00.000Z'), bar('2026-08-04T04:05:00.000Z')]);

    expect(detection.detectedAt).toBe('2026-08-04T04:05:00.000Z');
    expect(detection.detectedAt).not.toBe(SCAN_CLOCK.toISOString());
  });

  it('keeps the scan clock as execution time rather than discarding it', () => {
    // Both times matter and they are not interchangeable: the timeline orders by
    // market time, an audit asks when Sentinel actually looked.
    const detection = scanOnce([bar('2026-08-04T04:05:00.000Z')]);

    expect(detection.observedAt).toBe(SCAN_CLOCK.toISOString());
    expect(detection.detectedAt).not.toBe(detection.observedAt);
  });

  it('gives detections from different bars different times under one identical scan clock', () => {
    // The load-bearing one. Two observations made by the same poll clock must
    // not collapse onto that clock when the underlying bars differ — that
    // collapse is what made a session's setups read as one simultaneous burst.
    const earlier = scanOnce([bar('2026-08-04T04:45:00.000Z')]);
    const later = scanOnce([bar('2026-08-04T04:45:00.000Z'), bar('2026-08-04T09:29:00.000Z')]);

    expect(earlier.detectedAt).not.toBe(later.detectedAt);
    expect(new Date(later.detectedAt).getTime()).toBeGreaterThan(new Date(earlier.detectedAt).getTime());
    // Same execution clock throughout — the difference comes only from the market.
    expect(earlier.observedAt).toBe(later.observedAt);
  });

  it('falls back to the scan clock only when the snapshot has no bars at all', () => {
    // Nothing is fabricated in this case: with no candle there is no market
    // event to point at, and the scan clock is the honest answer.
    const detection = scanOnce([]);

    expect(detection.detectedAt).toBe(SCAN_CLOCK.toISOString());
    expect(detection.observedAt).toBe(SCAN_CLOCK.toISOString());
  });

  it('uses the newest historical bar before the session has any of its own', () => {
    // Pre-market: `sessionCandles` is empty but history is not, so the last real
    // bar is still a better answer than the wall clock.
    const detection = scanOnce([bar('2026-08-03T09:59:00.000Z')], SCAN_CLOCK, []);

    expect(detection.detectedAt).toBe('2026-08-03T09:59:00.000Z');
  });
});

describe('latestBarAt', () => {
  it('prefers the session bar over the wider history', () => {
    const at = latestBarAt({
      candles: [bar('2026-08-03T09:59:00.000Z')],
      sessionCandles: [bar('2026-08-04T04:05:00.000Z')],
    });

    expect(at?.toISOString()).toBe('2026-08-04T04:05:00.000Z');
  });

  it('is null when there is no bar to point at', () => {
    expect(latestBarAt({ candles: [], sessionCandles: [] })).toBeNull();
  });

  it('normalises a timestamp that arrived as an ISO string over a JSON hop', () => {
    const wire = { timestamp: '2026-08-04T04:05:00.000Z' } as unknown as Candle;

    expect(latestBarAt({ candles: [wire], sessionCandles: [] })?.toISOString()).toBe(
      '2026-08-04T04:05:00.000Z',
    );
  });

  it('refuses an unparseable timestamp rather than reporting an invalid date', () => {
    const broken = { timestamp: 'not-a-date' } as unknown as Candle;

    expect(latestBarAt({ candles: [broken], sessionCandles: [] })).toBeNull();
  });
});
