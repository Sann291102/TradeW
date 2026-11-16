import { describe, expect, it } from 'vitest';
import {
  breachesDrawdown,
  breachesExposure,
  computeDailyDrawdown,
  computeExposure,
  type RealizedTrade,
} from './execution-drawdown';

/** Trades at one-minute spacing, in the order given. */
function curve(...pnls: number[]): RealizedTrade[] {
  const base = Date.parse('2026-09-07T04:00:00.000Z');
  return pnls.map((realizedPnl, i) => ({ executedAt: new Date(base + i * 60_000), realizedPnl }));
}

describe('computeDailyDrawdown', () => {
  it('is flat on a day with no trades', () => {
    const read = computeDailyDrawdown([], 1_000_000);
    expect(read).toEqual({ peak: 0, current: 0, drawdown: 0, drawdownPct: 0 });
  });

  it('THE MOTIVATING CASE: a day that peaks +50,000 and gives back 45,000 is a 45,000 drawdown while P&L is still POSITIVE', () => {
    // This is precisely what `maxLossPerDay` cannot see: realized P&L never
    // goes below zero, so the absolute floor passes on every single pass while
    // the account hands back nearly everything it made.
    const read = computeDailyDrawdown(curve(30_000, 20_000, -25_000, -20_000), 1_000_000);

    expect(read.peak).toBe(50_000);
    expect(read.current).toBe(5_000);
    expect(read.drawdown).toBe(45_000);
    expect(read.current).toBeGreaterThan(0); // the loss floor would never fire
    expect(read.drawdownPct).toBe(4.5);
  });

  it('seeds the peak at zero, so a day that is red throughout still reports a drawdown', () => {
    // If the peak were seeded at the first trade's P&L, a day that only ever
    // lost money would report a drawdown measured from its FIRST loss, and a
    // single-trade losing day would report zero give-back. The day starts flat.
    const read = computeDailyDrawdown(curve(-10_000), 1_000_000);
    expect(read.peak).toBe(0);
    expect(read.current).toBe(-10_000);
    expect(read.drawdown).toBe(10_000);
  });

  it('never reports a negative drawdown on a day that only goes up', () => {
    const read = computeDailyDrawdown(curve(5_000, 5_000, 5_000), 1_000_000);
    expect(read.peak).toBe(15_000);
    expect(read.current).toBe(15_000);
    expect(read.drawdown).toBe(0);
  });

  it('measures from the peak, not from the start, after a recovery', () => {
    // +40k, down to +10k, back to +25k. The trough is behind us but the
    // give-back from the peak is still 15k.
    const read = computeDailyDrawdown(curve(40_000, -30_000, 15_000), 1_000_000);
    expect(read.peak).toBe(40_000);
    expect(read.current).toBe(25_000);
    expect(read.drawdown).toBe(15_000);
  });

  it('orders by executedAt, so an out-of-order input cannot move the peak', () => {
    const base = Date.parse('2026-09-07T04:00:00.000Z');
    const shuffled: RealizedTrade[] = [
      { executedAt: new Date(base + 120_000), realizedPnl: -25_000 },
      { executedAt: new Date(base), realizedPnl: 30_000 },
      { executedAt: new Date(base + 60_000), realizedPnl: 20_000 },
    ];
    const read = computeDailyDrawdown(shuffled, 1_000_000);
    // Chronologically: +30k, +50k, +25k -> peak 50k, current 25k.
    expect(read.peak).toBe(50_000);
    expect(read.current).toBe(25_000);
    expect(read.drawdown).toBe(25_000);
  });

  it('does not mutate the caller’s array while sorting', () => {
    const trades = curve(10, -5);
    const before = trades.map((t) => t.realizedPnl);
    computeDailyDrawdown(trades, 1_000);
    expect(trades.map((t) => t.realizedPnl)).toEqual(before);
  });

  it('reports an UNKNOWN percentage rather than 0% when the opening equity is unusable', () => {
    // 0% would silently pass a bound that was never actually evaluated.
    expect(computeDailyDrawdown(curve(-500), 0).drawdownPct).toBeNull();
    expect(computeDailyDrawdown(curve(-500), -100).drawdownPct).toBeNull();
  });
});

describe('breachesDrawdown', () => {
  const read = computeDailyDrawdown(curve(50_000, -45_000), 1_000_000); // 4.5%

  it('is never a breach when the bound is not configured', () => {
    expect(breachesDrawdown(read, null)).toBe(false);
  });

  it('breaches at or above the limit', () => {
    expect(breachesDrawdown(read, 4.5)).toBe(true);
    expect(breachesDrawdown(read, 4)).toBe(true);
    expect(breachesDrawdown(read, 5)).toBe(false);
  });

  it('does not breach on an unmeasurable percentage — an unknown bound is not a stop', () => {
    const unmeasurable = computeDailyDrawdown(curve(-1_000), 0);
    expect(unmeasurable.drawdownPct).toBeNull();
    expect(breachesDrawdown(unmeasurable, 1)).toBe(false);
  });
});

describe('computeExposure', () => {
  it('sums what is already open with what this pass would add', () => {
    const read = computeExposure({ openPremiumAtRisk: 40_000, proposedCost: 20_000, walletEquity: 1_000_000 });
    expect(read.openExposure).toBe(40_000);
    expect(read.proposedExposure).toBe(20_000);
    expect(read.totalExposure).toBe(60_000);
    expect(read.exposurePct).toBe(6);
  });

  it('THE MOTIVATING CASE: three positions at a 20% single-position allocation commit 60% of the account', () => {
    // Every per-position check passes; nothing bounded the sum until this.
    const read = computeExposure({ openPremiumAtRisk: 400_000, proposedCost: 200_000, walletEquity: 1_000_000 });
    expect(read.exposurePct).toBe(60);
    expect(breachesExposure(read, 50)).toBe(true);
    expect(breachesExposure(read, 75)).toBe(false);
  });

  it('treats negative inputs as zero rather than letting them offset real exposure', () => {
    const read = computeExposure({ openPremiumAtRisk: -50_000, proposedCost: 10_000, walletEquity: 100_000 });
    expect(read.openExposure).toBe(0);
    expect(read.totalExposure).toBe(10_000);
  });

  it('reports an UNKNOWN percentage rather than 0% when equity is unusable', () => {
    expect(computeExposure({ openPremiumAtRisk: 1, proposedCost: 1, walletEquity: 0 }).exposurePct).toBeNull();
  });

  it('is never a breach when the bound is not configured or cannot be measured', () => {
    const read = computeExposure({ openPremiumAtRisk: 900_000, proposedCost: 90_000, walletEquity: 1_000_000 });
    expect(breachesExposure(read, null)).toBe(false);
    const unmeasurable = computeExposure({ openPremiumAtRisk: 1, proposedCost: 1, walletEquity: 0 });
    expect(breachesExposure(unmeasurable, 1)).toBe(false);
  });

  it('breaches only ABOVE the limit, so a position sized exactly to the ceiling is allowed', () => {
    // Deliberately asymmetric with drawdown (which breaches AT the limit): a
    // position sized precisely to its own ceiling is the intended maximum, not
    // an overrun, whereas a drawdown that has REACHED its bound has already
    // given back what the bound exists to stop.
    const read = computeExposure({ openPremiumAtRisk: 0, proposedCost: 500_000, walletEquity: 1_000_000 });
    expect(read.exposurePct).toBe(50);
    expect(breachesExposure(read, 50)).toBe(false);
    expect(breachesExposure(read, 49.9)).toBe(true);
  });
});
