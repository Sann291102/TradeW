import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  analyseLiquidity,
  analyseStructure,
  detectSweep,
  findSwings,
  readBehaviour,
} from './market-structure';

/**
 * Structure and liquidity are what Phase 2 added to Sentinel's understanding,
 * and both are pure functions over candles — so they are tested directly, with
 * hand-built fixtures whose shape is obvious from reading them.
 *
 * Fixture warning worth repeating from the 2026-08-03 note: a swing needs
 * strictly higher highs / lower lows on BOTH sides. Filler bars must sit on
 * the correct side of the pivot or no swing is detected and the assertion
 * passes vacuously. Every fixture below is built with `bar()` so the pivot is
 * always genuinely extreme.
 */

let clock = 0;
function bar(high: number, low: number, close?: number, volume = 1000): Candle {
  clock += 900_000; // 15m
  const c = close ?? (high + low) / 2;
  return {
    timestamp: new Date(1_780_000_000_000 + clock),
    open: (high + low) / 2,
    high,
    low,
    close: c,
    volume,
  } as Candle;
}

/**
 * A downtrend with two confirmed swing highs (125 → 118) and two confirmed
 * swing lows (88 → 80). Last confirmed swing high is 118.
 */
function downtrendFixture(): Candle[] {
  return [
    bar(110, 100), bar(115, 105),
    bar(125, 115), // swing high 125
    bar(115, 105), bar(108, 98),
    bar(100, 88), // swing low 88
    bar(105, 95), bar(112, 102),
    bar(118, 108), // swing high 118 — lower high
    bar(110, 100), bar(102, 92),
    bar(95, 80), // swing low 80 — lower low
    bar(100, 90), bar(105, 95),
  ];
}

/** A confirmed swing high at the centre: strictly lower highs on both sides. */
function swingHighAt(peak: number): Candle[] {
  return [bar(peak - 10, peak - 30), bar(peak - 5, peak - 25), bar(peak, peak - 20), bar(peak - 5, peak - 25), bar(peak - 10, peak - 30)];
}

describe('findSwings', () => {
  it('finds a confirmed swing high with strictly lower highs on both sides', () => {
    const swings = findSwings(swingHighAt(100));
    const highs = swings.filter((s) => s.kind === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(100);
  });

  it('does not treat a flat run of equal highs as a swing', () => {
    // With `>=` every bar in a flat run registers, and the structure sequence
    // downstream becomes noise. Strictness is the guard.
    const candles = [bar(100, 80), bar(100, 80), bar(100, 80), bar(100, 80), bar(100, 80)];
    expect(findSwings(candles).filter((s) => s.kind === 'high')).toHaveLength(0);
  });

  it('never reports a swing in the last `strength` bars', () => {
    // An unconfirmed swing is a guess about bars that have not printed.
    const candles = [...swingHighAt(100), bar(200, 150)];
    const swings = findSwings(candles, 2);
    expect(swings.every((s) => s.index < candles.length - 2)).toBe(true);
  });

  it('returns nothing when there are too few bars to confirm anything', () => {
    expect(findSwings([bar(10, 5), bar(11, 6)])).toEqual([]);
  });
});

describe('analyseStructure', () => {
  it('reports undefined rather than guessing when swings are insufficient', () => {
    const s = analyseStructure([bar(10, 5), bar(11, 6)]);
    expect(s.state).toBe('undefined');
    expect(s.evidence[0]).toContain('Not enough confirmed swing points');
  });

  it('classifies an uptrend from higher highs and higher lows', () => {
    const candles = [
      bar(100, 90), bar(105, 95), bar(110, 100), bar(105, 95), bar(102, 92),
      bar(108, 98), bar(115, 105), bar(120, 110), bar(115, 108), bar(112, 104),
      bar(118, 110), bar(112, 106),
    ];
    expect(analyseStructure(candles).state).toBe('uptrend');
  });

  it('classifies a downtrend from lower highs and lower lows', () => {
    const candles = [
      bar(120, 110), bar(115, 105), bar(110, 100), bar(115, 105), bar(118, 108),
      bar(112, 102), bar(105, 95), bar(100, 90), bar(105, 95), bar(108, 98),
      bar(102, 92), bar(98, 88),
    ];
    expect(analyseStructure(candles).state).toBe('downtrend');
  });

  it('distinguishes a change of character from a break of structure', () => {
    // The two look identical on a chart and mean opposite things: a break
    // continues the trend, a change of character breaks it.
    //
    // This fixture needs TWO confirmed swing highs and TWO confirmed lows —
    // with only one of either, `analyseStructure` correctly reports
    // 'undefined' (one swing is a position, not a sequence) and no event is
    // ever evaluated. Getting this wrong is how a structure test passes
    // vacuously.
    const s = analyseStructure([...downtrendFixture(), bar(130, 120, 129)]);
    expect(s.state).toBe('downtrend');
    expect(s.event).toBe('change-of-character');
    expect(s.eventDirection).toBe('bullish');
    expect(s.evidence.join(' ')).toContain('character change');
  });

  it('reads the same break as continuation when structure is already with it', () => {
    // Identical price action, opposite meaning — the asymmetry this module exists for.
    const uptrend = [
      bar(100, 90), bar(105, 95), bar(95, 85), bar(105, 95), bar(112, 102),
      bar(120, 110), bar(112, 102), bar(105, 98), bar(115, 105), bar(122, 112),
      bar(130, 120), bar(122, 112), bar(118, 108), bar(124, 114),
    ];
    const s = analyseStructure([...uptrend, bar(140, 132, 139)]);
    expect(s.state).toBe('uptrend');
    expect(s.event).toBe('break-of-structure');
    expect(s.evidence.join(' ')).toContain('structure continuing');
  });

  it('always carries readable evidence for its conclusion', () => {
    const s = analyseStructure(swingHighAt(100));
    expect(s.evidence.length).toBeGreaterThan(0);
    for (const line of s.evidence) expect(line.length).toBeGreaterThan(0);
  });
});

describe('detectSweep — acceptance vs stop hunt', () => {
  it('flags a wick beyond the prior high that closes back inside as a reclaimed sweep', () => {
    const base = Array.from({ length: 10 }, () => bar(100, 90, 95));
    const sweep = [...base, bar(120, 94, 96)]; // pierced 100, closed back under
    const result = detectSweep(sweep);
    expect(result).toEqual({ side: 'above', price: 100, reclaimed: true });
  });

  it('does NOT call it a sweep when price closes beyond the level — that is acceptance', () => {
    // The distinction is the whole point: trading beyond and closing beyond
    // means the market genuinely revalued.
    const base = Array.from({ length: 10 }, () => bar(100, 90, 95));
    const accepted = [...base, bar(120, 94, 118)];
    expect(detectSweep(accepted)).toEqual({ side: 'above', price: 100, reclaimed: false });
  });

  it('detects a downside sweep symmetrically', () => {
    const base = Array.from({ length: 10 }, () => bar(100, 90, 95));
    const result = detectSweep([...base, bar(99, 70, 95)]);
    expect(result).toEqual({ side: 'below', price: 90, reclaimed: true });
  });

  it('returns null when price stayed inside the prior range', () => {
    const base = Array.from({ length: 10 }, () => bar(100, 90, 95));
    expect(detectSweep([...base, bar(99, 91, 95)])).toBeNull();
  });
});

describe('analyseLiquidity', () => {
  it('does not treat a single swing as a liquidity pool', () => {
    // Stops cluster where price has turned more than once at the same place.
    const read = analyseLiquidity(swingHighAt(100));
    expect(read.pools).toEqual([]);
  });

  it('clusters repeated swings at the same level into a pool', () => {
    const candles = [
      ...swingHighAt(100),
      bar(90, 80), bar(95, 85),
      ...swingHighAt(100.02), // within default 0.05% tolerance
      bar(90, 80),
    ];
    const read = analyseLiquidity(candles);
    const above = read.pools.filter((p) => p.side === 'above');
    expect(above.length).toBeGreaterThanOrEqual(1);
    expect(above[0].touches).toBeGreaterThanOrEqual(2);
  });

  it('uses a percentage tolerance so it holds across instruments of different scale', () => {
    // 0.05% of 24000 is 12 points; of 400 it is 0.2. An absolute tolerance
    // would treat every index swing as equal and no stock swing as equal.
    const wide = analyseLiquidity([...swingHighAt(24000), bar(23000, 22000), ...swingHighAt(24005), bar(23000, 22000)]);
    expect(wide.pools.some((p) => p.side === 'above' && p.touches >= 2)).toBe(true);
  });
});

describe('readBehaviour', () => {
  const noLiquidity = { pools: [], recentSweep: null, evidence: [] };

  it('returns undefined when structure is undefined rather than inventing a read', () => {
    const structure = analyseStructure([bar(10, 5)]);
    const b = readBehaviour(structure, noLiquidity, { volumeVsAvg: 1.5, momentumScore: 0.8 });
    expect(b.read).toBe('undefined');
    expect(b.strength).toBe(0);
  });

  it('reads a change of character as reversal risk, never as a prediction', () => {
    const structure = {
      state: 'downtrend' as const,
      event: 'change-of-character' as const,
      eventDirection: 'bullish' as const,
      lastSwingHigh: null,
      lastSwingLow: null,
      evidence: [],
    };
    const b = readBehaviour(structure, noLiquidity, { volumeVsAvg: 1.4, momentumScore: 0.7 });
    expect(b.read).toBe('reversal-risk');
    expect(b.direction).toBe('bullish');
    // Vocabulary check: describes present evidence, never a forecast.
    expect(JSON.stringify(b)).not.toMatch(/will |going to |expect/i);
  });

  it('treats thin volume as evidence against the move', () => {
    const structure = {
      state: 'uptrend' as const,
      event: 'break-of-structure' as const,
      eventDirection: 'bullish' as const,
      lastSwingHigh: null,
      lastSwingLow: null,
      evidence: [],
    };
    const strong = readBehaviour(structure, noLiquidity, { volumeVsAvg: 1.5, momentumScore: 0.8 });
    const thin = readBehaviour(structure, noLiquidity, { volumeVsAvg: 0.4, momentumScore: 0.8 });
    expect(thin.strength).toBeLessThan(strong.strength);
    expect(thin.evidence.join(' ')).toContain('not being participated in');
  });

  it('flags a counter-directional reclaimed sweep as trapped participation', () => {
    const structure = {
      state: 'uptrend' as const,
      event: 'break-of-structure' as const,
      eventDirection: 'bullish' as const,
      lastSwingHigh: null,
      lastSwingLow: null,
      evidence: [],
    };
    const liquidity = {
      pools: [],
      recentSweep: { side: 'above' as const, price: 100, reclaimed: true },
      evidence: [],
    };
    const b = readBehaviour(structure, liquidity, { volumeVsAvg: 1.2, momentumScore: 0.6 });
    expect(b.evidence.join(' ')).toContain('being trapped');
  });

  it('reads a range with no structural event as indecision', () => {
    const structure = {
      state: 'range' as const,
      event: null,
      eventDirection: null,
      lastSwingHigh: null,
      lastSwingLow: null,
      evidence: [],
    };
    const b = readBehaviour(structure, noLiquidity, { volumeVsAvg: 1.5, momentumScore: 0.9 });
    expect(b.read).toBe('indecision');
    expect(b.direction).toBe('neutral');
  });

  it('keeps strength inside 0..1 under every input', () => {
    const structure = {
      state: 'uptrend' as const,
      event: 'change-of-character' as const,
      eventDirection: 'bullish' as const,
      lastSwingHigh: null,
      lastSwingLow: null,
      evidence: [],
    };
    const hot = readBehaviour(structure, { pools: [], recentSweep: { side: 'below', price: 1, reclaimed: true }, evidence: [] }, {
      volumeVsAvg: 9,
      momentumScore: 1,
    });
    expect(hot.strength).toBeLessThanOrEqual(1);
    expect(hot.strength).toBeGreaterThanOrEqual(0);
  });
});
