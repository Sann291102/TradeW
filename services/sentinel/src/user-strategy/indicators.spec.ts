import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  atr,
  bodyInteraction,
  classifySlope,
  emaOf,
  emaSeries,
  findBullishReclaim,
  findBullishReclaims,
  volumeAboveAverage,
} from './indicators';

/**
 * These are ports, so the assertions are numeric and pinned rather than
 * shape-based. "Looks like an EMA" is not the property that matters; "produces
 * the same number as `ema_series` in sentinel-py" is, because a user's rule
 * fires on one side of a threshold or the other.
 *
 * The cross-engine evidence lives in `replay-parity.spec.ts`. This file covers
 * the boundaries a random corpus reaches rarely — empty input, exactly-at-the-
 * period lengths, zero scale — where a port most often diverges silently.
 */

function bar(o: number, h: number, l: number, c: number, v = 1000, minute = 0): Candle {
  return { timestamp: new Date(Date.UTC(2026, 7, 31, 4, minute)), open: o, high: h, low: l, close: c, volume: v };
}
const flat = (n: number, price = 100, vol = 1000) =>
  Array.from({ length: n }, (_, i) => bar(price, price, price, price, vol, i));

describe('emaSeries', () => {
  it('is seeded with the SMA of the first `period` values, not the first value', () => {
    // The seed is the difference between this port and the obvious one, and it
    // matters for exactly the window a short intraday history lives in.
    const values = [1, 2, 3, 4, 5];
    expect(emaSeries(values, 5)).toEqual([3]); // (1+2+3+4+5)/5
  });

  it('returns one value per input from index period-1 onward', () => {
    expect(emaSeries([1, 2, 3, 4, 5, 6], 3)).toHaveLength(4);
  });

  it('applies the 2/(period+1) multiplier', () => {
    // seed = (10+20)/2 = 15; next = (30 - 15) * (2/3) + 15 = 25
    expect(emaSeries([10, 20, 30], 2)).toEqual([15, 25]);
  });

  it('returns empty below `period` values rather than an EMA of too little data', () => {
    expect(emaSeries([1, 2], 7)).toEqual([]);
    expect(emaSeries([], 7)).toEqual([]);
  });

  it('refuses a non-positive period', () => {
    expect(emaSeries([1, 2, 3], 0)).toEqual([]);
    expect(emaSeries([1, 2, 3], -1)).toEqual([]);
  });

  it('emaOf reads closes', () => {
    const candles = [bar(1, 1, 1, 10, 1, 0), bar(1, 1, 1, 20, 1, 1)];
    expect(emaOf(candles, 2)).toEqual([15]);
  });
});

describe('classifySlope', () => {
  it('needs lookback + 1 values, and reads flat below that', () => {
    expect(classifySlope([1, 2, 3], 3)).toBe('flat');
    expect(classifySlope([1, 2, 3, 4], 3, 1)).toBe('rising');
  });

  it('normalises against ATR so the verdict is scale-free', () => {
    // The same +3 move is decisive on a ₹2 ATR and noise on a ₹100 one.
    expect(classifySlope([100, 101, 102, 103], 3, 2)).toBe('rising');
    expect(classifySlope([100, 101, 102, 103], 3, 100)).toBe('flat');
  });

  it('sits exactly on the ±0.25 thresholds', () => {
    // change/scale must EXCEED 0.25, not merely reach it.
    expect(classifySlope([0, 0, 0, 0.25], 3, 1)).toBe('flat');
    expect(classifySlope([0, 0, 0, 0.2501], 3, 1)).toBe('rising');
    expect(classifySlope([0, 0, 0, -0.25], 3, 1)).toBe('flat');
    expect(classifySlope([0, 0, 0, -0.2501], 3, 1)).toBe('falling');
  });

  it('falls back to a relative scale when no ATR is supplied', () => {
    // scale = |last| * 0.001 = 0.1 for a value of 100.
    expect(classifySlope([100, 100, 100, 100.05], 3, null)).toBe('rising');
    expect(classifySlope([100, 100, 100, 100.01], 3, null)).toBe('flat');
  });

  it('reads flat rather than dividing by zero when the scale collapses', () => {
    // The fallback scale is |last| * 0.001, so it only collapses when the last
    // value is itself zero — with a last value of 5 the scale is 0.005 and a
    // +5 move is correctly decisive, which is why that is asserted separately
    // below rather than lumped in here.
    expect(classifySlope([0, 0, 0, 0], 3, 0)).toBe('flat');
    expect(classifySlope([0, 0, 0, 0], 3, null)).toBe('flat');
  });

  it('uses the LAST value for the fallback scale, so a move off zero still registers', () => {
    // scale = |5| * 0.001 = 0.005, normalised = 1000.
    expect(classifySlope([0, 0, 0, 5], 3, null)).toBe('rising');
  });
});

describe('atr', () => {
  it('is null below period + 1 candles rather than an average of whatever is there', () => {
    expect(atr(flat(14), 14)).toBeNull();
    expect(atr(flat(15), 14)).not.toBeNull();
  });

  it('measures true range including the gap against the previous close', () => {
    const candles = [bar(10, 10, 10, 10, 1, 0), bar(20, 22, 18, 20, 1, 1)];
    // TR = max(22-18, |22-10|, |18-10|) = 12
    expect(atr(candles, 1)).toBe(12);
  });

  it('is zero on a flat series rather than null', () => {
    expect(atr(flat(20), 14)).toBe(0);
  });
});

describe('bodyInteraction', () => {
  it('separates a body touch from a wick touch — the distinction the family rests on', () => {
    // Body 100–105, wick reaches 95.
    const candle = bar(100, 106, 95, 105);
    expect(bodyInteraction(candle, 102).touchedBody).toBe(true);
    expect(bodyInteraction(candle, 97).touchedBody).toBe(false);
    expect(bodyInteraction(candle, 97).touchedWick).toBe(true);
  });

  it('treats the body bounds as inclusive', () => {
    const candle = bar(100, 110, 90, 105);
    expect(bodyInteraction(candle, 100).touchedBody).toBe(true);
    expect(bodyInteraction(candle, 105).touchedBody).toBe(true);
  });

  it('reports close position independently of the touch', () => {
    const candle = bar(100, 110, 90, 105);
    expect(bodyInteraction(candle, 102).closedAbove).toBe(true);
    expect(bodyInteraction(candle, 107).closedAbove).toBe(false);
    expect(bodyInteraction(candle, 107).closedBelow).toBe(true);
    // A close exactly ON the level is neither above nor below.
    expect(bodyInteraction(candle, 105).closedAbove).toBe(false);
    expect(bodyInteraction(candle, 105).closedBelow).toBe(false);
  });
});

describe('findBullishReclaims', () => {
  const ema = [100, 100, 100, 100];

  it('requires the body to reach the level AND the close to be above it', () => {
    const candles = [
      bar(102, 103, 101, 102, 1, 0), // clear of the EMA — no touch
      bar(99, 104, 98, 103, 1, 1), // body 99–103 straddles 100, closes above ✓
      bar(101, 102, 95, 101, 1, 2), // wick only
      bar(101, 102, 99, 99.5, 1, 3), // body touches but closes BELOW
    ];
    const found = findBullishReclaims(candles, ema);
    expect(found.map((r) => r.index)).toEqual([1]);
  });

  it('returns every reclaim oldest-first, not only the newest', () => {
    // The documented reason: a candle that follows through on an earlier
    // reclaim can itself qualify, and keeping only the newest made the setup
    // permanently "still waiting".
    const candles = [
      bar(99, 104, 98, 103, 1, 0),
      bar(99, 104, 98, 103, 1, 1),
      bar(99, 104, 98, 103, 1, 2),
      bar(99, 104, 98, 103, 1, 3),
    ];
    expect(findBullishReclaims(candles, ema).map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(findBullishReclaim(candles, ema)?.index).toBe(3);
  });

  it('aligns the EMA series against the tail of the candle list', () => {
    // Four candles, a two-value EMA: the EMA describes candles 2 and 3 only,
    // so a reclaim on candle 0 must not be found against candle 2's level.
    const candles = [
      bar(99, 104, 98, 103, 1, 0),
      bar(99, 104, 98, 103, 1, 1),
      bar(50, 51, 49, 50.5, 1, 2),
      bar(49, 52, 48, 51, 1, 3),
    ];
    const found = findBullishReclaims(candles, [50, 50]);
    expect(found.map((r) => r.index)).toEqual([2, 3]);
  });

  it('returns nothing for an empty EMA series', () => {
    expect(findBullishReclaims([bar(99, 104, 98, 103)], [])).toEqual([]);
    expect(findBullishReclaim([bar(99, 104, 98, 103)], [])).toBeNull();
  });
});

describe('volumeAboveAverage', () => {
  it('EXCLUDES the current bar from its own baseline', () => {
    // The difference from intelligence/indicators.ts averageVolume, and the
    // reason these primitives are not shared: including the bar lets a spike
    // lift the average it is being compared against.
    const candles = [...flat(20, 100, 1000), bar(100, 100, 100, 100, 5000, 20)];
    const read = volumeAboveAverage(candles, 20)!;
    expect(read.average).toBe(1000); // not (20*1000 + 5000)/21
    expect(read.latest).toBe(5000);
    expect(read.met).toBe(true);
  });

  it('is null below period + 1 candles', () => {
    expect(volumeAboveAverage(flat(20), 20)).toBeNull();
    expect(volumeAboveAverage(flat(21), 20)).not.toBeNull();
  });

  it('is null when the instrument reports no volume at all', () => {
    expect(volumeAboveAverage(flat(25, 100, 0), 20)).toBeNull();
  });

  it('requires strictly greater, not equal', () => {
    const candles = flat(21, 100, 1000);
    expect(volumeAboveAverage(candles, 20)!.met).toBe(false);
  });
});
