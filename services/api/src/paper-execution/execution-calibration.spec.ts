import { describe, expect, it } from 'vitest';
import * as calibrationModule from './execution-calibration';
import {
  MAX_FLOOR_DECREASE,
  MAX_FLOOR_INCREASE,
  MIN_CALIBRATION_TRADES,
  PLATFORM_CONFIDENCE_FLOOR,
  applyCalibration,
  calibrationKey,
  floorAdjustment,
  foldOutcome,
  type CalibrationSample,
} from './execution-calibration';

/**
 * Bounded learning.
 *
 * The assertions that matter are the ones about what learning CANNOT do. A
 * system that learns from outcomes and also causes them is a closed loop
 * nobody is supervising, and the only thing standing between "adaptive" and
 * "talks itself into a trade" is that the bounds actually hold.
 */

const EMPTY: CalibrationSample = { trades: 0, wins: 0, losses: 0, scratches: 0, grossPnl: 0, avgRMultiple: null };

function foldMany(rs: number[], result: (r: number) => string = (r) => (r > 0 ? 'WIN' : r < 0 ? 'LOSS' : 'SCRATCH')) {
  return rs.reduce(
    (sample, r) => foldOutcome(sample, { result: result(r), realizedPnl: r * 1000, rMultiple: r }),
    EMPTY,
  );
}

describe('calibrationKey', () => {
  it('composes one key from the five dimensions', () => {
    expect(
      calibrationKey({
        agent: 'sentinel-alpha',
        symbol: 'nifty',
        strategyId: 'agent-trend-momentum',
        strategyVersion: '1.0.0',
        regime: 'trending',
      }),
    ).toBe('sentinel-alpha|NIFTY|agent-trend-momentum|1.0.0|trending');
  });

  it('normalises the symbol so a reader and a writer cannot disagree', () => {
    const base = { agent: 'a', strategyId: 's', strategyVersion: '1.0.0', regime: 'trending' };
    expect(calibrationKey({ ...base, symbol: 'nifty' })).toBe(calibrationKey({ ...base, symbol: 'NIFTY' }));
  });

  it('separates strategy VERSIONS into different buckets', () => {
    const base = { agent: 'a', symbol: 'NIFTY', strategyId: 's', regime: 'trending' };
    // Retuning a strategy's rules must start a fresh sample rather than
    // averaging the new rules' results with the old ones'.
    expect(calibrationKey({ ...base, strategyVersion: '1.0.0' })).not.toBe(
      calibrationKey({ ...base, strategyVersion: '1.1.0' }),
    );
  });

  it('separates REGIMES', () => {
    const base = { agent: 'a', symbol: 'NIFTY', strategyId: 's', strategyVersion: '1.0.0' };
    expect(calibrationKey({ ...base, regime: 'trending' })).not.toBe(calibrationKey({ ...base, regime: 'ranging' }));
  });
});

describe('foldOutcome', () => {
  it('counts wins, losses and scratches separately', () => {
    const s = foldMany([1, -1, 0, 2, -0.5]);
    expect(s.trades).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    // A scratch is its own outcome, never a small win or a small loss.
    expect(s.scratches).toBe(1);
  });

  it('tracks a running mean R', () => {
    expect(foldMany([1, 1, 1]).avgRMultiple).toBeCloseTo(1, 3);
    expect(foldMany([3, -1, -1, -1]).avgRMultiple).toBeCloseTo(0, 3);
  });

  it('accumulates gross P&L', () => {
    expect(foldMany([1, -1, 2]).grossPnl).toBe(2000);
  });

  it('counts a trade with no R without polluting the mean', () => {
    // A pre-2026-08-30 intent recorded no risk budget, so its R is unknown —
    // which is not zero. Treating it as zero would drag every mean toward the
    // middle and make a good bucket look mediocre.
    const withR = foldOutcome(EMPTY, { result: 'WIN', realizedPnl: 2000, rMultiple: 2 });
    const plusUnknown = foldOutcome(withR, { result: 'WIN', realizedPnl: 1000, rMultiple: null });
    expect(plusUnknown.trades).toBe(2);
    expect(plusUnknown.wins).toBe(2);
    expect(plusUnknown.grossPnl).toBe(3000);
    expect(plusUnknown.avgRMultiple).toBe(2); // unchanged by the unknown
  });
});

describe('floorAdjustment', () => {
  it('does nothing below the sample floor', () => {
    for (let n = 1; n < MIN_CALIBRATION_TRADES; n++) {
      const sample = foldMany(Array.from({ length: n }, () => -3));
      expect(floorAdjustment(sample), `${n} trades`).toBe(0);
    }
  });

  it('RAISES the bar for a losing bucket', () => {
    const losing = foldMany(Array.from({ length: 10 }, () => -1));
    const adjustment = floorAdjustment(losing);
    expect(adjustment).toBeGreaterThan(0);
    expect(applyCalibration(70, adjustment)).toBeGreaterThan(70);
  });

  it('is derived from average R, not win rate', () => {
    // 70% wins, and a loser overall: wins of +0.3R, losses of −1.5R.
    const highWinRateLosingBucket = foldMany([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, -1.5, -1.5, -1.5]);
    expect(highWinRateLosingBucket.wins).toBe(7);
    expect(highWinRateLosingBucket.losses).toBe(3);
    expect(highWinRateLosingBucket.avgRMultiple).toBeLessThan(0);
    // Win rate alone would promote this bucket. Average R correctly does not.
    expect(floorAdjustment(highWinRateLosingBucket)).toBeGreaterThan(0);
  });

  it('is bounded in both directions', () => {
    const catastrophic = foldMany(Array.from({ length: 20 }, () => -50));
    expect(floorAdjustment(catastrophic)).toBe(MAX_FLOOR_INCREASE);
    const spectacular = foldMany(Array.from({ length: 20 }, () => 50));
    expect(floorAdjustment(spectacular)).toBe(MAX_FLOOR_DECREASE);
  });

  it('never emits a value outside its own bounds, over a wide sweep', () => {
    for (let meanR = -20; meanR <= 20; meanR += 0.25) {
      const sample = foldMany(Array.from({ length: 12 }, () => meanR));
      const adjustment = floorAdjustment(sample);
      expect(adjustment).toBeGreaterThanOrEqual(MAX_FLOOR_DECREASE);
      expect(adjustment).toBeLessThanOrEqual(MAX_FLOOR_INCREASE);
      expect(Number.isInteger(adjustment)).toBe(true);
    }
  });
});

describe('applyCalibration — the floor learning cannot cross', () => {
  it('never returns below the platform floor, whatever it is given', () => {
    // The single most important assertion in this file. Swept over every
    // adjustment in and well OUTSIDE the legal range, because a row written
    // directly into `StrategyCalibration` by a restore or a manual edit is not
    // constrained by `floorAdjustment`.
    for (let profileFloor = 0; profileFloor <= 100; profileFloor += 5) {
      for (let adjustment = -500; adjustment <= 500; adjustment += 7) {
        expect(applyCalibration(profileFloor, adjustment)).toBeGreaterThanOrEqual(PLATFORM_CONFIDENCE_FLOOR);
      }
    }
  });

  it('lets a good bucket relax a STRICTER profile back toward the platform bar', () => {
    // The negative branch is only meaningful for a profile that asked for more
    // than 70. This is what it is for.
    expect(applyCalibration(85, -5)).toBe(80);
    expect(applyCalibration(72, -5)).toBe(70); // clamped, not 67
  });

  it('lets a bad bucket raise the bar above the profile’s own', () => {
    expect(applyCalibration(70, 15)).toBe(85);
  });

  it('is a no-op at zero', () => {
    expect(applyCalibration(70, 0)).toBe(70);
    expect(applyCalibration(80, 0)).toBe(80);
  });
});

describe('what learning structurally cannot reach', () => {
  it('the calibration module exports nothing that touches risk, stops or arming', () => {
    // A structural assertion rather than a behavioural one: the module's whole
    // surface is a key, a fold, an adjustment and a clamp. There is no
    // exported function here that could move a stop, a target, a trail, a risk
    // budget or an arming state, so no future call site can make one do so.
    const surface = Object.keys(calibrationModule).sort();
    expect(surface).toEqual([
      'MAX_FLOOR_DECREASE',
      'MAX_FLOOR_INCREASE',
      'MIN_CALIBRATION_TRADES',
      'PLATFORM_CONFIDENCE_FLOOR',
      'applyCalibration',
      'calibrationKey',
      'floorAdjustment',
      'foldOutcome',
    ]);
  });
});
