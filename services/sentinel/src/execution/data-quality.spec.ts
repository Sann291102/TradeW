import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BAR_AGE_MINUTES, DEFAULT_MIN_CANDLES, assessDataQuality } from './data-quality';

/**
 * The gate that separates "a live read" from "the stored history the provider
 * quietly fell back to".
 *
 * `CandleMarketDataProvider` serves any Candle row inside a five-day window
 * when the live bridge is unreachable, and reports it identically to a live
 * read. Every assertion here is about that specific failure being visible.
 */

const NOW = new Date('2026-08-30T09:00:00.000Z'); // 14:30 IST
const base = {
  now: NOW,
  candles: 120,
  newestBarAt: new Date(NOW.getTime() - 5 * 60_000),
  spot: 24_500,
  optionChainStrikes: 41,
  minCandles: DEFAULT_MIN_CANDLES,
  maxBarAgeMinutes: DEFAULT_MAX_BAR_AGE_MINUTES,
  requireOptionChain: true,
};

describe('assessDataQuality', () => {
  it('passes a healthy live read and reports the bar age', () => {
    const read = assessDataQuality(base);
    expect(read.ok).toBe(true);
    expect(read.failedCheckId).toBeNull();
    expect(read.barAgeMinutes).toBe(5);
    expect(read.checks.every((c) => c.passed)).toBe(true);
  });

  it('refuses bars older than the allowance, naming the age', () => {
    const read = assessDataQuality({ ...base, newestBarAt: new Date(NOW.getTime() - 4 * 3_600_000) });
    expect(read.ok).toBe(false);
    expect(read.failedCheckId).toBe('bar-freshness');
    expect(read.barAgeMinutes).toBe(240);
    // The reason has to say it is stored history — "no market data" was the
    // 2026-08-17 wording that sent the investigation to the wrong service.
    expect(read.reason).toContain('stored history');
  });

  it('separates "no bars at all" from "stale bars"', () => {
    const read = assessDataQuality({ ...base, candles: 0, newestBarAt: null });
    expect(read.ok).toBe(false);
    // History is checked before freshness, so the more fundamental failure is
    // the one reported.
    expect(read.failedCheckId).toBe('candle-history');
    expect(read.barAgeMinutes).toBeNull();
    const freshness = read.checks.find((c) => c.id === 'bar-freshness')!;
    expect(freshness.passed).toBe(false);
    expect(freshness.detail).toContain('no bars');
  });

  it('refuses a history too short for its own indicators', () => {
    const read = assessDataQuality({ ...base, candles: 12 });
    expect(read.ok).toBe(false);
    expect(read.failedCheckId).toBe('candle-history');
    expect(read.reason).toContain('12 bars');
  });

  it('refuses a missing spot — a strike cannot be located without one', () => {
    const read = assessDataQuality({ ...base, spot: null });
    expect(read.ok).toBe(false);
    expect(read.failedCheckId).toBe('index-spot');
  });

  it('refuses a missing chain when one is required, and reports it when not', () => {
    const required = assessDataQuality({ ...base, optionChainStrikes: 0 });
    expect(required.ok).toBe(false);
    expect(required.failedCheckId).toBe('option-chain');

    const optional = assessDataQuality({ ...base, optionChainStrikes: 0, requireOptionChain: false });
    expect(optional.ok).toBe(true);
    // Still reported, so the console can show the chain was absent even
    // though it did not block this particular read.
    expect(optional.checks.find((c) => c.id === 'option-chain')!.detail).toContain('not required');
  });

  it('reports every check whether or not it failed', () => {
    const read = assessDataQuality({ ...base, candles: 3, spot: null });
    expect(read.checks.map((c) => c.id)).toEqual([
      'candle-history',
      'bar-freshness',
      'index-spot',
      'option-chain',
    ]);
  });

  it('never reports a negative age for a bar stamped in the future', () => {
    // Clock skew between the bridge and this process is real; a negative age
    // would read as "fresher than now" and pass every comparison.
    const read = assessDataQuality({ ...base, newestBarAt: new Date(NOW.getTime() + 60_000) });
    expect(read.barAgeMinutes).toBe(0);
    expect(read.ok).toBe(true);
  });
});
