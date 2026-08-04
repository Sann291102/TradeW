import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  findFairValueGaps,
  findFibonacci,
  findLevels,
  findLiquidityPools,
  findSwings,
  findTrendLines,
  findZones,
} from './geometry';

/**
 * Geometry is what a trader sees drawn on their chart, so these tests are
 * built from hand-constructed bar sequences with a known answer rather than
 * from snapshots of real data — a snapshot test would lock in whatever the
 * code did on the day it was written, including its bugs.
 */

const MINUTE = 60_000;
let clock = Date.UTC(2026, 7, 3, 3, 45);

function bar(open: number, high: number, low: number, close: number, volume = 1000): Candle {
  clock += 15 * MINUTE;
  return { timestamp: new Date(clock), open, high, low, close, volume };
}

/** Reset the shared clock so each test's timestamps start from a known point. */
function series(build: () => Candle[]): Candle[] {
  clock = Date.UTC(2026, 7, 3, 3, 45);
  return build();
}

/** Flat filler bars at `price`, used to pad a series to a usable length. */
function flat(price: number, count: number): Candle[] {
  return Array.from({ length: count }, () => bar(price, price + 1, price - 1, price));
}

describe('findSwings', () => {
  it('finds a pivot high that clears its neighbours on both sides', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 120, 99, 118), // the pivot
      ...flat(100, 3),
    ]);

    const swings = findSwings(candles, 3);
    const highs = swings.filter((s) => s.kind === 'high');

    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(120);
    expect(highs[0].index).toBe(3);
  });

  it('never reports a pivot inside the final `lookback` bars', () => {
    // A pivot whose right-hand side has not formed yet would repaint as new
    // bars arrive. The last three bars must therefore never qualify.
    const candles = series(() => [...flat(100, 5), bar(100, 200, 99, 195), bar(100, 101, 99, 100)]);

    const swings = findSwings(candles, 3);

    expect(swings.every((s) => s.index < candles.length - 3)).toBe(true);
    expect(swings.some((s) => s.price === 200)).toBe(false);
  });

  it('returns nothing when there are fewer bars than the window needs', () => {
    const candles = series(() => flat(100, 4));
    expect(findSwings(candles, 3)).toEqual([]);
  });
});

describe('findLevels', () => {
  it('clusters pivots that sit within the percentage tolerance', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 120, 99, 118),
      ...flat(100, 3),
      bar(100, 120.1, 99, 118), // within 0.15% of 120
      ...flat(100, 3),
    ]);

    const levels = findLevels(findSwings(candles, 3), 0.15, 2);
    const resistance = levels.filter((l) => l.kind === 'resistance');

    expect(resistance).toHaveLength(1);
    expect(resistance[0].touches).toHaveLength(2);
    expect(resistance[0].price).toBeCloseTo(120.05, 2);
  });

  it('keeps pivots further apart than the tolerance as separate levels', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 120, 99, 118),
      ...flat(100, 3),
      bar(100, 121, 99, 118), // ~0.83% away — a different level
      ...flat(100, 3),
      bar(100, 120.05, 99, 118),
      ...flat(100, 3),
    ]);

    const levels = findLevels(findSwings(candles, 3), 0.15, 2);

    // 120 and 120.05 cluster; 121 does not join them.
    expect(levels.every((l) => l.touches.every((t) => Math.abs(t.price - l.price) / l.price < 0.0015))).toBe(true);
  });

  it('requires the configured minimum number of touches', () => {
    const candles = series(() => [...flat(100, 3), bar(100, 120, 99, 118), ...flat(100, 3)]);
    expect(findLevels(findSwings(candles, 3), 0.15, 2)).toEqual([]);
  });
});

describe('findZones', () => {
  it('marks the base before an impulse, not the impulse bar itself', () => {
    const candles = series(() => [
      ...flat(100, 5),
      bar(100, 100.5, 99.5, 100), // base
      bar(100, 108, 99.8, 107), // +7% impulse
      ...flat(107, 4),
    ]);

    const zones = findZones(candles, { impulseThresholdPct: 0.6, maxBaseBars: 3 });
    const demand = zones.find((z) => z.kind === 'demand');

    expect(demand).toBeDefined();
    // The zone is the tight base, so its top is well below the impulse high.
    expect(demand!.top).toBeLessThan(108);
    expect(demand!.bottom).toBeLessThanOrEqual(100);
  });

  it('marks a zone mitigated once price trades back through it', () => {
    const candles = series(() => [
      ...flat(100, 5),
      bar(100, 100.5, 99.5, 100),
      bar(100, 108, 99.8, 107),
      ...flat(107, 2),
      bar(107, 107.5, 99, 100), // returns into the base
      ...flat(100, 2),
    ]);

    const zones = findZones(candles, { impulseThresholdPct: 0.6 });
    const demand = zones.find((z) => z.kind === 'demand');

    expect(demand?.unmitigated).toBe(false);
  });

  it('ignores moves below the impulse threshold', () => {
    const candles = series(() => flat(100, 20));
    expect(findZones(candles, { impulseThresholdPct: 0.6 })).toEqual([]);
  });
});

describe('findLiquidityPools', () => {
  it('pairs equal highs into a buy-side pool', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 120, 99, 118),
      ...flat(100, 3),
      bar(100, 120.05, 99, 118),
      ...flat(100, 3),
    ]);

    const pools = findLiquidityPools(candles, findSwings(candles, 3), 0.08);
    const buySide = pools.find((p) => p.kind === 'buy-side');

    expect(buySide).toBeDefined();
    expect(buySide!.points).toHaveLength(2);
    expect(buySide!.swept).toBe(false);
  });

  it('marks a pool swept once price trades through it', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 120, 99, 118),
      ...flat(100, 3),
      bar(100, 120.05, 99, 118),
      ...flat(100, 3),
      bar(100, 125, 99, 124), // takes the equal highs out
      ...flat(124, 3),
    ]);

    const pools = findLiquidityPools(candles, findSwings(candles, 3), 0.08);
    const buySide = pools.find((p) => p.kind === 'buy-side');

    expect(buySide?.swept).toBe(true);
  });

  it('does not call a single pivot a pool', () => {
    const candles = series(() => [...flat(100, 3), bar(100, 120, 99, 118), ...flat(100, 3)]);
    expect(findLiquidityPools(candles, findSwings(candles, 3), 0.08)).toEqual([]);
  });
});

describe('findFairValueGaps', () => {
  it('detects a bullish three-bar imbalance and reports its bounds', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 101, 99, 100.5), // bar 1: high 101
      bar(101, 110, 100.9, 109), // bar 2: the displacement
      bar(109, 112, 105, 111), // bar 3: low 105 > bar 1 high 101
    ]);

    const gaps = findFairValueGaps(candles);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].direction).toBe('bullish');
    expect(gaps[0].bottom).toBe(101);
    expect(gaps[0].top).toBe(105);
  });

  it('excludes a gap price has already traded back into', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 101, 99, 100.5),
      bar(101, 110, 100.9, 109),
      bar(109, 112, 105, 111),
      bar(111, 111.5, 100, 102), // fills the gap
    ]);

    expect(findFairValueGaps(candles)).toEqual([]);
  });
});

describe('findTrendLines', () => {
  it('fits an ascending line through rising lows', () => {
    // The filler bars must sit ABOVE the pivots, or the pivots are not pivots:
    // a swing low requires strictly higher lows on both sides.
    const candles = series(() => [
      ...flat(110, 3), // lows at 109
      bar(110, 112, 100, 111), // pivot low at 100
      ...flat(115, 3), // lows at 114
      bar(115, 118, 106, 117), // higher pivot low at 106
      ...flat(120, 3), // lows at 119
    ]);

    const lines = findTrendLines(candles, findSwings(candles, 3));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].kind).toBe('ascending');
    expect(lines[0].slope).toBeGreaterThan(0);
    expect(lines[0].from.price).toBe(100);
    expect(lines[0].to.price).toBe(106);
  });

  it('rejects a line a candle body closed through', () => {
    // Two rising pivot lows at 100 and 106, with a bar between them closing at
    // 101 while the line sits near 103. Wicks may pierce a trendline; a close
    // through it is a break, and the line must not be drawn from that anchor.
    // The violating bar's LOW stays above 100 so the first pivot still forms.
    const candles = series(() => [
      ...flat(120, 2), // lows at 119
      bar(120, 122, 100, 121), // pivot low at 100
      ...flat(112, 2), // lows at 111
      bar(111, 112, 100.5, 101), // closes beneath the line
      ...flat(112, 2), // lows at 111
      bar(111, 118, 106, 117), // pivot low at 106
      ...flat(120, 2), // lows at 119
    ]);

    const lines = findTrendLines(candles, findSwings(candles, 2));
    const spanningTheBreak = lines.find((l) => l.kind === 'ascending' && l.from.price === 100);

    expect(spanningTheBreak).toBeUndefined();
    // A line anchored after the break is still legitimate and should be found.
    expect(lines.some((l) => l.kind === 'ascending')).toBe(true);
  });

  it('returns nothing when there are fewer than two pivots of a kind', () => {
    const candles = series(() => flat(100, 12));
    expect(findTrendLines(candles, findSwings(candles, 3))).toEqual([]);
  });
});

describe('findFibonacci', () => {
  it('measures the largest opposite-pivot leg and places 61.8% correctly', () => {
    const candles = series(() => [
      ...flat(100, 3),
      bar(100, 101, 90, 95), // low pivot at 90
      ...flat(120, 3),
      bar(130, 190, 129, 185), // high pivot at 190
      ...flat(150, 3),
    ]);

    const fib = findFibonacci(findSwings(candles, 3));

    expect(fib).not.toBeNull();
    expect(fib!.direction).toBe('up');
    const level618 = fib!.levels.find((l) => l.ratio === 0.618)!;
    // Retracement is measured back from the leg's end toward its origin.
    const span = fib!.to.price - fib!.from.price;
    expect(level618.price).toBeCloseTo(fib!.to.price - span * 0.618, 5);
  });

  it('returns null when there are not two opposite pivots', () => {
    expect(findFibonacci([])).toBeNull();
  });
});
