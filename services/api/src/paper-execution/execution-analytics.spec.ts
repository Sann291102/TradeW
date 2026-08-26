import { describe, expect, it } from 'vitest';
import {
  type AnalyticsOutcomeRow,
  computeExecutionAnalytics,
  confidenceBand,
} from './execution-analytics';

const row = (over: Partial<AnalyticsOutcomeRow>): AnalyticsOutcomeRow => ({
  realizedPnl: 0,
  result: 'SCRATCH',
  holdingSeconds: 300,
  strategyId: 'orb',
  strategyName: 'Opening Range Breakout',
  symbol: 'NIFTY',
  side: 'CE',
  confidence: 82,
  strikeRole: 'ATM',
  regime: 'trending',
  exitReason: 'SQUARE_OFF',
  entryHourIst: 10,
  exitAtMs: 0,
  ...over,
});

describe('confidenceBand', () => {
  it('buckets on the documented boundaries', () => {
    expect(confidenceBand(69)).toBe('below-70');
    expect(confidenceBand(70)).toBe('70-74');
    expect(confidenceBand(74)).toBe('70-74');
    expect(confidenceBand(75)).toBe('75-79');
    expect(confidenceBand(84)).toBe('80-84');
    expect(confidenceBand(85)).toBe('85-89');
    expect(confidenceBand(90)).toBe('90-100');
    expect(confidenceBand(100)).toBe('90-100');
  });
});

describe('computeExecutionAnalytics — summary math', () => {
  const rows = [
    row({ result: 'WIN', realizedPnl: 1000, exitAtMs: 1 }),
    row({ result: 'LOSS', realizedPnl: -400, exitAtMs: 2 }),
    row({ result: 'WIN', realizedPnl: 600, exitAtMs: 3 }),
    row({ result: 'LOSS', realizedPnl: -200, exitAtMs: 4 }),
    row({ result: 'SCRATCH', realizedPnl: 0, exitAtMs: 5 }),
  ];
  const { summary } = computeExecutionAnalytics(rows);

  it('counts wins, losses, scratches and the decided win rate', () => {
    expect(summary.count).toBe(5);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(2);
    expect(summary.scratches).toBe(1);
    expect(summary.winRate).toBe(50); // 2 of 4 DECIDED, scratch excluded
  });

  it('computes gross/net P&L, averages, expectancy and profit factor', () => {
    expect(summary.grossProfit).toBe(1600);
    expect(summary.grossLoss).toBe(-600);
    expect(summary.netPnl).toBe(1000);
    expect(summary.avgWin).toBe(800);
    expect(summary.avgLoss).toBe(-300);
    expect(summary.expectancy).toBe(200); // 1000 / 5 trades
    expect(summary.profitFactor).toBe(2.67); // 1600 / 600
    expect(summary.largestWin).toBe(1000);
    expect(summary.largestLoss).toBe(-400);
    expect(summary.avgHoldingSeconds).toBe(300);
  });

  it('measures max drawdown as the largest peak-to-trough dip, ordered by exit', () => {
    // Equity curve: 1000 (peak) → 600 (−400 dip) → 1200 (peak) → 1000 → 1000.
    expect(summary.maxDrawdown).toBe(400);
  });
});

describe('computeExecutionAnalytics — edge cases', () => {
  it('reports honest nulls for an empty set rather than zeros that read as real', () => {
    const { summary } = computeExecutionAnalytics([]);
    expect(summary.count).toBe(0);
    expect(summary.winRate).toBeNull();
    expect(summary.expectancy).toBeNull();
    expect(summary.profitFactor).toBeNull();
    expect(summary.avgWin).toBeNull();
    expect(summary.avgLoss).toBeNull();
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.largestWin).toBe(0);
  });

  it('leaves profit factor null when there are no losing trades (never Infinity)', () => {
    const { summary } = computeExecutionAnalytics([
      row({ result: 'WIN', realizedPnl: 500 }),
      row({ result: 'WIN', realizedPnl: 300 }),
    ]);
    expect(summary.profitFactor).toBeNull();
    expect(summary.avgLoss).toBeNull();
    expect(summary.grossLoss).toBe(0);
    expect(summary.winRate).toBe(100);
  });
});

describe('computeExecutionAnalytics — breakdowns', () => {
  const rows = [
    row({ result: 'WIN', realizedPnl: 900, strategyName: 'ORB', strikeRole: 'ATM', confidence: 91, symbol: 'NIFTY', entryHourIst: 10 }),
    row({ result: 'LOSS', realizedPnl: -300, strategyName: 'VWAP', strikeRole: 'OTM', confidence: 72, symbol: 'BANKNIFTY', entryHourIst: 13 }),
    row({ result: 'WIN', realizedPnl: 400, strategyName: 'ORB', strikeRole: 'ATM', confidence: 88, symbol: 'NIFTY', entryHourIst: 10 }),
  ];
  const a = computeExecutionAnalytics(rows);

  it('breaks performance down by strategy, sorted by net P&L', () => {
    expect(a.byStrategy.map((g) => g.key)).toEqual(['ORB', 'VWAP']);
    const orb = a.byStrategy.find((g) => g.key === 'ORB')!;
    expect(orb.count).toBe(2);
    expect(orb.netPnl).toBe(1300);
    expect(orb.winRate).toBe(100);
  });

  it('breaks down by confidence band, instrument, strike role, hour and side', () => {
    expect(a.byConfidenceBand.map((g) => g.key)).toEqual(['70-74', '85-89', '90-100']);
    expect(a.byInstrument.map((g) => g.key).sort()).toEqual(['BANKNIFTY', 'NIFTY']);
    expect(a.byStrikeRole.find((g) => g.key === 'ATM')!.count).toBe(2);
    expect(a.byHourOfDay.map((g) => g.key)).toEqual(['10:00 IST', '13:00 IST']);
    expect(a.bySide.find((g) => g.key === 'CE')!.count).toBe(3);
  });

  it('skips a dimension a row cannot answer rather than inventing a bucket', () => {
    const withNulls = computeExecutionAnalytics([
      row({ result: 'WIN', realizedPnl: 100, regime: null, strikeRole: null }),
    ]);
    expect(withNulls.byRegime).toHaveLength(0);
    expect(withNulls.byStrikeRole).toHaveLength(0);
  });
});
