import type { Candle } from '@tradew/types';
import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { EVIDENCE_KEYS, EVIDENCE_READERS, readEvidence } from './evidence';

/**
 * The "important information only" filter.
 *
 * Two properties matter here and nothing else does:
 *
 *  1. A strategy reads EXACTLY what it declares. Anything else influencing the
 *     decision would make the declaration a comment rather than a contract.
 *  2. A stance is always relative to the direction being evaluated. The same
 *     RSI of 74 supports an exhaustion-reversal short and opposes a momentum
 *     long, and a reader that returned an absolute "bullish/bearish" would
 *     score one of those two backwards.
 */

function candles(count = 30, close = 24_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 7, 30, 4, i * 15)),
    open: close - 10,
    high: close + 15,
    low: close - 15,
    close,
    volume: 100_000,
  }));
}

function snapshotOf(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'NIFTY',
    lastPrice: 24_200,
    rsi14: 58,
    ema20: 24_150,
    ema50: 24_000,
    vwap: 24_100,
    macdHistogram: 8,
    cpr: { pivot: 24_050, bc: 24_020, tc: 24_080 },
    volumeVsAvg: 1.3,
    oiTrend: 'rising',
    realizedVolPct: 0.9,
    vix: 13,
    breadthRatio: 1.5,
    support: 24_000,
    resistance: 24_400,
    candles: candles(),
    sessionCandles: candles(12),
    priorDay: null,
    marketProfile: {
      type: 'Bullish Trend Day',
      description: 'x',
      trend: 'bullish',
      volatility: 'normal',
      structure: 'trending',
      evidence: [],
    },
    trendAnalysis: { sessionChangePct: 0.9, momentumScore: 0.6, volumeStrength: 1.3, direction: 'bullish' },
    openingRange: { high: 24_120, low: 24_020, establishedAt: new Date(Date.UTC(2026, 7, 30, 4, 0)) },
    optionChain: {
      pcr: 1.4,
      maxPain: 24_400,
      callOIWall: 24_500,
      putOIWall: 24_000,
      strikesAnalysed: 40,
      frontExpiry: new Date(Date.UTC(2026, 7, 31)),
      entries: [],
    },
    ...overrides,
  } as MarketSnapshot;
}

describe('readEvidence', () => {
  it('reads exactly the declared keys and nothing else', () => {
    const read = readEvidence(snapshotOf(), 'bullish', ['index-trend', 'vwap-position']);
    expect(read.items.map((i) => i.id)).toEqual(['index-trend', 'vwap-position']);
    // Nine other readers exist and could all have read this snapshot. None did.
    expect(read.items).toHaveLength(2);
  });

  it('carries the knowledge concept on every item', () => {
    const read = readEvidence(snapshotOf(), 'bullish', ['index-trend', 'option-pcr']);
    expect(read.items.map((i) => i.concept)).toEqual(['trend', 'put-call-ratio']);
  });

  it('reports a declared key with no reader rather than dropping it', () => {
    const read = readEvidence(snapshotOf(), 'bullish', ['index-trend', 'not-a-real-key']);
    expect(read.items.map((i) => i.id)).toEqual(['index-trend']);
    expect(read.unavailable).toEqual([
      { id: 'not-a-real-key', reason: 'No reader is registered for this evidence key.' },
    ]);
  });

  it('reports a key whose data is absent, with the reason', () => {
    const read = readEvidence(snapshotOf({ vwap: null, rsi14: null }), 'bullish', ['vwap-position', 'momentum-rsi']);
    expect(read.items).toHaveLength(0);
    expect(read.unavailable.map((u) => u.id).sort()).toEqual(['momentum-rsi', 'vwap-position']);
  });

  it('inverts stance with the direction — the same reading, both ways', () => {
    const snapshot = snapshotOf();
    const bull = readEvidence(snapshot, 'bullish', ['vwap-position']).items[0];
    const bear = readEvidence(snapshot, 'bearish', ['vwap-position']).items[0];
    expect(bull.stance).toBe('supports');
    expect(bear.stance).toBe('opposes');
    // The MEASUREMENT is identical; only the interpretation flips.
    expect(bull.value).toBe(bear.value);
  });

  it('treats a stretched RSI as exhaustion evidence FOR the fade, not against it', () => {
    const overbought = snapshotOf({ rsi14: 78 });
    // A momentum strategy reading the same number the ordinary way sees it as
    // supporting a long…
    expect(readEvidence(overbought, 'bullish', ['momentum-rsi']).items[0].stance).toBe('supports');
    // …while the exhaustion reader sees an overbought market as supporting the
    // SHORT. Both are correct for their own strategy, which is exactly why two
    // readers exist over one number.
    expect(readEvidence(overbought, 'bearish', ['momentum-exhaustion']).items[0].stance).toBe('supports');
    expect(readEvidence(overbought, 'bullish', ['momentum-exhaustion']).items[0].stance).toBe('opposes');
  });

  it('never lets thin volume count as evidence AGAINST a direction', () => {
    // Volume has no direction of its own; the absence of participation is an
    // absence of evidence. It withholds support rather than opposing.
    const strong = readEvidence(snapshotOf({ volumeVsAvg: 1.5 }), 'bullish', ['volume-confirmation']).items[0];
    const middling = readEvidence(snapshotOf({ volumeVsAvg: 0.9 }), 'bullish', ['volume-confirmation']).items[0];
    expect(strong.stance).toBe('supports');
    expect(middling.stance).toBe('neutral');
    // …and the same for a bearish read: volume is symmetric.
    expect(readEvidence(snapshotOf({ volumeVsAvg: 1.5 }), 'bearish', ['volume-confirmation']).items[0].stance).toBe(
      'supports',
    );
  });

  it('treats volatility as context, never as a side', () => {
    for (const direction of ['bullish', 'bearish'] as const) {
      expect(readEvidence(snapshotOf(), direction, ['volatility-regime']).items[0].stance).toBe('neutral');
    }
  });

  it('weights the support ratio by the strategy’s own declaration', () => {
    // index-trend supports (bullish session), momentum-exhaustion opposes
    // (RSI 78 against a bullish read). Equal weights → 50%.
    const snapshot = snapshotOf({ rsi14: 78 });
    const even = readEvidence(snapshot, 'bullish', ['index-trend', 'momentum-exhaustion']);
    expect(even.supportRatio).toBeCloseTo(0.5, 5);

    // Triple the weight of the supporting read → 75%.
    const weighted = readEvidence(snapshot, 'bullish', ['index-trend', 'momentum-exhaustion'], { 'index-trend': 3 });
    expect(weighted.supportRatio).toBeCloseTo(0.75, 5);
  });

  it('reports a 0 support ratio when nothing took a side, not a divide-by-zero', () => {
    const read = readEvidence(snapshotOf(), 'bullish', ['volatility-regime', 'oi-trend']);
    expect(read.supportRatio).toBe(0);
    expect(Number.isFinite(read.supportRatio)).toBe(true);
    expect(read.summary).toContain('took a side');
  });

  it('lists the opposing readings by name so a refusal is explainable', () => {
    const read = readEvidence(snapshotOf({ rsi14: 78, breadthRatio: 0.5 }), 'bullish', [
      'index-trend',
      'momentum-exhaustion',
      'market-breadth',
    ]);
    expect(read.opposing.map((o) => o.id).sort()).toEqual(['market-breadth', 'momentum-exhaustion']);
    expect(read.summary).toContain('Market breadth');
  });

  it('reads OI walls relative to the direction of travel in BOTH directions', () => {
    // Spot 24,200 with a call wall at 24,500 (300 above) and a put wall at
    // 24,000 (200 below). A bullish read has more room ahead than behind…
    const snapshot = snapshotOf();
    expect(readEvidence(snapshot, 'bullish', ['option-oi-walls']).items[0].stance).toBe('supports');
    // …and the bearish read of the identical chain must therefore oppose. The
    // first version of this reader hardcoded 'bullish' into its stance
    // computation and returned 'supports' for both.
    expect(readEvidence(snapshot, 'bearish', ['option-oi-walls']).items[0].stance).toBe('opposes');
  });
});

describe('the reader catalogue', () => {
  it('exposes every key it registers', () => {
    expect(EVIDENCE_KEYS.sort()).toEqual(Object.keys(EVIDENCE_READERS).sort());
    expect(EVIDENCE_KEYS.length).toBeGreaterThanOrEqual(15);
  });

  it('every reader survives a completely empty snapshot without throwing', () => {
    // A snapshot at 09:15 with nothing computed yet is the ordinary first
    // observation of every session, not an edge case.
    const empty = snapshotOf({
      lastPrice: 0,
      rsi14: null,
      ema20: null,
      ema50: null,
      vwap: null,
      macdHistogram: null,
      cpr: null,
      volumeVsAvg: null,
      realizedVolPct: null,
      vix: null,
      breadthRatio: null,
      support: null,
      resistance: null,
      candles: [],
      sessionCandles: [],
      marketProfile: null,
      trendAnalysis: null,
      openingRange: null,
      optionChain: null,
      oiTrend: 'unknown',
    });
    const read = readEvidence(empty, 'bullish', EVIDENCE_KEYS);
    expect(read.items).toHaveLength(0);
    expect(read.unavailable).toHaveLength(EVIDENCE_KEYS.length);
  });
});
