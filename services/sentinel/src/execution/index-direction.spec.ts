import type { Candle } from '@tradew/types';
import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { MIN_DIRECTION_STRENGTH, alignedOptionSide, readIndexDirection } from './index-direction';

/**
 * The index's own read, and the property the whole two-read design rests on:
 * it is computed from the index and nothing else.
 *
 * `knowledge/Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on
 * signals that had none.md` records what happens when a direction is inferred
 * from something that is not the index. The last test in this file is the
 * structural guard against that class of bug returning here.
 */

/** A rising series with clean higher highs and higher lows. */
function risingCandles(count = 60, start = 24_000): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    // A gentle zig-zag on an upward drift, so swing detection has real swings
    // to find rather than a monotonic line with none.
    const wobble = i % 4 === 3 ? -12 : 10;
    const open = price;
    price += wobble;
    out.push({
      timestamp: new Date(Date.UTC(2026, 7, 30, 4, i * 15)),
      open,
      high: Math.max(open, price) + 5,
      low: Math.min(open, price) - 5,
      close: price,
      volume: 100_000,
    });
  }
  return out;
}

function fallingCandles(count = 60, start = 24_000): Candle[] {
  return risingCandles(count, start)
    .map((c, i, all) => {
      const mirrored = 2 * start - c.close;
      const prev = i === 0 ? start : 2 * start - all[i - 1].close;
      return {
        ...c,
        open: prev,
        close: mirrored,
        high: Math.max(prev, mirrored) + 5,
        low: Math.min(prev, mirrored) - 5,
      };
    });
}

function snapshotOf(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  const candles = overrides.candles ?? risingCandles();
  const last = candles[candles.length - 1];
  return {
    symbol: 'NIFTY',
    lastPrice: last?.close ?? 24_000,
    rsi14: 55,
    ema20: 24_100,
    ema50: 24_000,
    vwap: 24_050,
    macdHistogram: 5,
    cpr: null,
    volumeVsAvg: 1.2,
    oiTrend: 'rising',
    realizedVolPct: 0.8,
    vix: 12,
    breadthRatio: 1.4,
    support: 23_900,
    resistance: 24_400,
    candles,
    sessionCandles: candles.slice(-20),
    priorDay: null,
    marketProfile: null,
    trendAnalysis: { sessionChangePct: 1.2, momentumScore: 0.7, volumeStrength: 1.2, direction: 'bullish' },
    openingRange: { high: 24_050, low: 23_950, establishedAt: new Date(Date.UTC(2026, 7, 30, 4, 0)) },
    optionChain: null,
    ...overrides,
  } as MarketSnapshot;
}

describe('readIndexDirection', () => {
  it('reads a clean uptrend as bullish with high agreement', () => {
    const read = readIndexDirection(snapshotOf({ lastPrice: 24_300 }));
    expect(read.direction).toBe('bullish');
    expect(read.strength).toBeGreaterThanOrEqual(MIN_DIRECTION_STRENGTH);
    expect(read.summary).toContain('bullish');
  });

  it('reads a clean downtrend as bearish', () => {
    const candles = fallingCandles();
    const read = readIndexDirection(
      snapshotOf({
        candles,
        sessionCandles: candles.slice(-20),
        lastPrice: 23_700,
        ema20: 23_800,
        ema50: 23_950,
        vwap: 23_900,
        macdHistogram: -5,
        breadthRatio: 0.6,
        openingRange: { high: 24_050, low: 23_950, establishedAt: new Date(Date.UTC(2026, 7, 30, 4, 0)) },
        trendAnalysis: { sessionChangePct: -1.1, momentumScore: 0.7, volumeStrength: 1.1, direction: 'bearish' },
      }),
    );
    expect(read.direction).toBe('bearish');
    expect(read.strength).toBeGreaterThanOrEqual(MIN_DIRECTION_STRENGTH);
  });

  it('answers "unclear" when the reads are split rather than picking the bigger half', () => {
    // Price above VWAP and outside the opening range high (bullish reads),
    // against a bearish EMA stack and a bearish session (bearish reads).
    const candles = risingCandles();
    const read = readIndexDirection(
      snapshotOf({
        candles,
        lastPrice: 24_200,
        ema20: 24_250, // price below fast EMA…
        ema50: 24_400, // …and the stack is bearish
        vwap: 24_100, // but price is above VWAP
        trendAnalysis: { sessionChangePct: -0.8, momentumScore: 0.6, volumeStrength: 1, direction: 'bearish' },
        openingRange: { high: 24_150, low: 24_050, establishedAt: new Date(Date.UTC(2026, 7, 30, 4, 0)) },
      }),
    );
    expect(['unclear', 'neutral']).toContain(read.direction);
    expect(read.conflicts.length).toBeGreaterThan(0);
  });

  it('abstains rather than voting when the inputs are absent', () => {
    const read = readIndexDirection(
      snapshotOf({
        candles: [],
        sessionCandles: [],
        ema20: null,
        ema50: null,
        vwap: null,
        trendAnalysis: null,
        openingRange: null,
        lastPrice: 0,
      }),
    );
    expect(read.direction).toBe('unclear');
    expect(read.strength).toBe(0);
    // Every read is still REPORTED, as an abstention with a reason — an
    // operator asking "why is nothing trading" gets five explanations, not an
    // empty object.
    expect(read.votes).toHaveLength(5);
    expect(read.votes.every((v) => v.detail.startsWith('Abstained'))).toBe(true);
  });

  it('does not let one unopposed read pass as unanimous', () => {
    // Only the session trend has an opinion; everything else abstains. Without
    // the participation floor this would be strength 1.0 off a single vote.
    const read = readIndexDirection(
      snapshotOf({
        candles: [],
        sessionCandles: [],
        ema20: null,
        ema50: null,
        vwap: null,
        openingRange: null,
        lastPrice: 0,
        trendAnalysis: { sessionChangePct: 2, momentumScore: 0.9, volumeStrength: 2, direction: 'bullish' },
      }),
    );
    expect(read.direction).toBe('unclear');
    expect(read.summary).toContain('participation floor');
  });

  it('every vote names the knowledge concept it applies', () => {
    const read = readIndexDirection(snapshotOf({}));
    for (const vote of read.votes) {
      expect(vote.concept).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('NEVER consults the option chain — the index is the context', () => {
    // Same index, wildly different chains. If any option datum leaked into the
    // index read, these two would differ.
    const withoutChain = readIndexDirection(snapshotOf({ optionChain: null }));
    const withChain = readIndexDirection(
      snapshotOf({
        optionChain: {
          pcr: 0.2, // screamingly bearish positioning
          maxPain: 20_000,
          callOIWall: 24_100,
          putOIWall: 20_000,
          strikesAnalysed: 40,
          frontExpiry: new Date(Date.UTC(2026, 7, 31)),
          entries: [],
        },
      }),
    );
    expect(withChain.direction).toBe(withoutChain.direction);
    expect(withChain.strength).toBe(withoutChain.strength);
  });
});

describe('alignedOptionSide', () => {
  it('maps a direction to the one option side it permits', () => {
    expect(alignedOptionSide('bullish')).toBe('CE');
    expect(alignedOptionSide('bearish')).toBe('PE');
  });

  it('permits NO side when the index is neutral or unclear', () => {
    expect(alignedOptionSide('neutral')).toBeNull();
    expect(alignedOptionSide('unclear')).toBeNull();
  });
});
