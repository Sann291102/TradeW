import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { buildIndicatorStrip, ema, macd, rsi, vwap } from './indicators';

/**
 * The indicator strip is computed from REAL candles and must never fabricate a
 * value it cannot honestly derive. These tests pin the math against known
 * inputs and assert the "not enough data → null" contract that keeps the UI
 * from showing an invented reading.
 */

function c(close: number, opts: Partial<Candle> = {}): Candle {
  return {
    timestamp: opts.timestamp ?? new Date('2026-08-10T04:00:00Z'),
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 0,
    openInterest: opts.openInterest,
  };
}

describe('ema', () => {
  it('returns null when fewer than `period` values', () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
  });
  it('equals the constant for a flat series', () => {
    expect(ema([10, 10, 10, 10, 10], 3)).toBeCloseTo(10, 6);
  });
  it('tracks toward recent values', () => {
    const v = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(8); // weighted toward the recent 10
  });
});

describe('rsi', () => {
  it('returns null with too few bars', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
  it('is 100 for a strictly rising series (no losses)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBe(100);
  });
  it('stays within 0..100', () => {
    const closes = [44, 44.3, 44.1, 43.6, 44.3, 44.8, 45.1, 45.4, 45.4, 46, 46.6, 46.3, 46.3, 46, 46.2, 46.2];
    const v = rsi(closes, 14) as number;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

describe('vwap', () => {
  it('returns null when there is no volume to weight by', () => {
    expect(vwap([c(100), c(101)])).toBeNull();
  });
  it('is the volume-weighted typical price', () => {
    const day = new Date('2026-08-10T05:00:00Z');
    const a = c(100, { high: 100, low: 100, close: 100, volume: 100, timestamp: day });
    const b = c(200, { high: 200, low: 200, close: 200, volume: 300, timestamp: day });
    // (100*100 + 200*300) / 400 = 175
    expect(vwap([a, b])).toBeCloseTo(175, 6);
  });
});

describe('macd', () => {
  it('returns null until there are enough bars for the signal line', () => {
    expect(macd(Array.from({ length: 20 }, (_, i) => i))).toBeNull();
  });
  it('is bullish when the fast EMA leads an accelerating series', () => {
    // An accelerating (convex) uptrend keeps the MACD line rising, so the
    // signal line lags below it and the histogram stays positive — a flat
    // linear ramp would instead converge the histogram to ~0.
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.1);
    const m = macd(closes);
    expect(m).not.toBeNull();
    expect(m!.bias).toBe('bullish');
    expect(m!.histogram).toBeGreaterThan(0);
  });
});

describe('buildIndicatorStrip', () => {
  it('returns all-null on an empty series (no fabrication)', () => {
    const s = buildIndicatorStrip(null);
    expect(s.ema20).toBeNull();
    expect(s.rsi14).toBeNull();
    expect(s.macd).toBeNull();
  });
  it('flags EMA position relative to last close', () => {
    const rising = Array.from({ length: 30 }, (_, i) => c(100 + i));
    const s = buildIndicatorStrip(rising);
    expect(s.ema20Position).toBe('above'); // last close is above a lagging EMA
  });
});
