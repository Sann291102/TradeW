import { describe, expect, it } from 'vitest';
import { barReturns, computeMetrics, drawdown, regimeBuckets, sampleEquity } from './backtest-metrics';
import type { SimEquityPoint, SimResult, SimTrade } from './execution-simulator';

/**
 * The metrics suite.
 *
 * Half of these assert arithmetic. The other half assert an ABSENCE — that a
 * metric which cannot mean anything on this sample is stored as null instead of
 * printed. That second half is the one worth keeping: a Sharpe over four trades
 * is not a small number, it is not a number, and a metrics grid gives no visual
 * clue which of its cells are which.
 */

function trade(over: Partial<SimTrade> = {}): SimTrade {
  return {
    sequence: 1,
    side: 'BUY',
    entryBarIndex: 0,
    entryTime: new Date('2026-05-04T04:00:00Z'),
    entryPrice: 100,
    entryQuantity: 10,
    exitBarIndex: 2,
    exitTime: new Date('2026-05-04T04:30:00Z'),
    exitPrice: 110,
    exitReason: 'TARGET',
    grossPnl: 100,
    fees: 1,
    slippageCost: 1,
    netPnl: 98,
    holdingSeconds: 1800,
    barsHeld: 2,
    cashAfter: 1_000_098,
    stopPrice: 99,
    targetPrice: 110,
    strategyId: 's',
    strategyName: 'S',
    confidence: 80,
    strategyReason: [],
    marketContext: null,
    ...over,
  };
}

function point(seq: number, value: number, at = new Date(2026, 4, 4 + seq)): SimEquityPoint {
  return {
    sequence: seq,
    at,
    cash: value,
    portfolioValue: value,
    realizedPnl: value - 1_000_000,
    unrealizedPnl: 0,
    drawdownPct: 0,
    openPositions: 0,
  };
}

function result(trades: SimTrade[], equity: SimEquityPoint[], over: Partial<SimResult> = {}): SimResult {
  return {
    trades,
    equity,
    skips: [],
    finalCash: equity.length ? equity[equity.length - 1].portfolioValue : 1_000_000,
    finalPortfolioValue: equity.length ? equity[equity.length - 1].portfolioValue : 1_000_000,
    exposedBars: 10,
    barsWalked: 100,
    ...over,
  };
}

describe('computeMetrics — suppression', () => {
  const shortRun = {
    initialCapital: 1_000_000,
    timeframe: '15m',
    firstBarAt: new Date('2026-05-04T00:00:00Z'),
    lastBarAt: new Date('2026-05-20T00:00:00Z'),
  };

  it('stores NULL rather than a number for Sharpe/Sortino on a tiny sample', () => {
    const m = computeMetrics({
      sim: result([trade(), trade({ sequence: 2, netPnl: -50 })], [point(0, 1_000_000), point(1, 1_000_048)]),
      ...shortRun,
    });
    expect(m.totalTrades).toBe(2);
    expect(m.sharpe).toBeNull();
    expect(m.sortino).toBeNull();
    expect(m.volatilityPct).toBeNull();
    expect(m.suppressed.some((s) => s.metric.includes('sharpe'))).toBe(true);
  });

  it('suppresses CAGR below 90 days rather than annualising noise', () => {
    const m = computeMetrics({ sim: result([trade()], [point(0, 1_000_000), point(1, 1_100_000)]), ...shortRun });
    expect(m.cagrPct).toBeNull();
    expect(m.suppressed.some((s) => s.metric === 'cagrPct')).toBe(true);
  });

  it('computes CAGR once the window is long enough', () => {
    const m = computeMetrics({
      sim: result([trade()], [point(0, 1_000_000), point(1, 1_100_000)]),
      initialCapital: 1_000_000,
      timeframe: '1d',
      firstBarAt: new Date('2026-01-01T00:00:00Z'),
      lastBarAt: new Date('2026-12-31T00:00:00Z'),
    });
    expect(m.cagrPct).not.toBeNull();
    expect(m.cagrPct!).toBeGreaterThan(9);
    expect(m.cagrPct!).toBeLessThan(11);
  });

  it('reports profit factor as NULL — not Infinity — when there is no losing trade', () => {
    const m = computeMetrics({ sim: result([trade(), trade({ sequence: 2 })], [point(0, 1_000_000)]), ...shortRun });
    expect(m.losingTrades).toBe(0);
    expect(m.profitFactor).toBeNull();
    expect(m.suppressed.some((s) => s.metric === 'profitFactor')).toBe(true);
  });
});

describe('computeMetrics — arithmetic', () => {
  const base = {
    initialCapital: 1_000_000,
    timeframe: '15m',
    firstBarAt: new Date('2026-05-04T00:00:00Z'),
    lastBarAt: new Date('2026-06-04T00:00:00Z'),
  };

  it('counts wins, losses and break-evens without overlap', () => {
    const m = computeMetrics({
      sim: result(
        [
          trade({ sequence: 1, netPnl: 100 }),
          trade({ sequence: 2, netPnl: -40 }),
          trade({ sequence: 3, netPnl: 0 }),
        ],
        [point(0, 1_000_000), point(1, 1_000_060)],
      ),
      ...base,
    });
    expect(m.totalTrades).toBe(3);
    expect(m.winningTrades).toBe(1);
    expect(m.losingTrades).toBe(1);
    expect(m.breakEvenTrades).toBe(1);
    expect(m.winningTrades + m.losingTrades + m.breakEvenTrades).toBe(m.totalTrades);
  });

  it('profit factor is gross win over gross loss', () => {
    const m = computeMetrics({
      sim: result(
        [trade({ sequence: 1, netPnl: 300 }), trade({ sequence: 2, netPnl: -100 })],
        [point(0, 1_000_000), point(1, 1_000_200)],
      ),
      ...base,
    });
    expect(m.profitFactor).toBe(3);
    expect(m.expectancy).toBe(100);
  });

  it('sums fees and slippage across every trade', () => {
    const m = computeMetrics({
      sim: result(
        [trade({ sequence: 1, fees: 5, slippageCost: 2 }), trade({ sequence: 2, fees: 7, slippageCost: 3 })],
        [point(0, 1_000_000)],
      ),
      ...base,
    });
    expect(m.totalFees).toBe(12);
    expect(m.totalSlippage).toBe(5);
    expect(m.averageSlippage).toBe(2.5);
  });

  it('exposure is the share of walked bars with a position open', () => {
    const m = computeMetrics({
      sim: result([trade()], [point(0, 1_000_000)], { exposedBars: 25, barsWalked: 100 }),
      ...base,
    });
    expect(m.exposurePct).toBe(25);
  });
});

describe('drawdown', () => {
  it('measures peak-to-trough on the curve, not on the trade sequence', () => {
    const curve = [point(0, 1_000_000), point(1, 1_200_000), point(2, 900_000), point(3, 1_050_000)];
    const dd = drawdown(curve, 1_000_000);
    // From the 1,200,000 peak down to 900,000 = 25%.
    expect(dd.maxPct).toBeCloseTo(25, 4);
    expect(dd.maxAmount).toBeCloseTo(300_000, 2);
  });

  it('reports zero for a curve that only ever rises', () => {
    const dd = drawdown([point(0, 1_000_000), point(1, 1_100_000), point(2, 1_200_000)], 1_000_000);
    expect(dd.maxPct).toBe(0);
    expect(dd.days).toBe(0);
  });

  it('distinguishes a recovered drawdown from one still under water', () => {
    const recovered = drawdown(
      [point(0, 1_000_000), point(1, 800_000), point(2, 1_000_000), point(3, 1_010_000)],
      1_000_000,
    );
    expect(recovered.recovered).toBe(true);

    const under = drawdown([point(0, 1_000_000), point(1, 800_000), point(2, 850_000)], 1_000_000);
    expect(under.recovered).toBe(false);
    expect(under.maxPct).toBeCloseTo(20, 4);
  });

  it('measures the drawdown from the PEAK, not from the starting capital', () => {
    // Doubles, then halves: a 50% drawdown, not a 0% one.
    const dd = drawdown([point(0, 1_000_000), point(1, 2_000_000), point(2, 1_000_000)], 1_000_000);
    expect(dd.maxPct).toBeCloseTo(50, 4);
  });
});

describe('barReturns', () => {
  it('is bar-over-bar and skips a non-positive base', () => {
    expect(barReturns([point(0, 100), point(1, 110), point(2, 99)])).toEqual([0.1, expect.closeTo(-0.1, 6)]);
    expect(barReturns([point(0, 0), point(1, 110)])).toEqual([]);
  });
});

describe('regimeBuckets', () => {
  it('buckets by the stored context and never invents a label', () => {
    const trades = [
      trade({ sequence: 1, netPnl: 100, marketContext: { trend: 'bullish', volatilityRegime: 'high' } }),
      trade({ sequence: 2, netPnl: -50, marketContext: { trend: 'bearish', volatilityRegime: 'high' } }),
      trade({ sequence: 3, netPnl: 20, marketContext: null }),
    ];
    const buckets = regimeBuckets(trades);
    const trend = buckets.filter((b) => b.dimension === 'trend');
    expect(trend.map((b) => b.label).sort()).toEqual(['bearish', 'bullish', 'unknown']);
    // The unclassified trade is its OWN bucket — not distributed into the others.
    expect(trend.find((b) => b.label === 'unknown')!.trades).toBe(1);
  });

  it('suppresses a win rate computed over fewer than five trades', () => {
    const buckets = regimeBuckets([trade({ marketContext: { trend: 'bullish', volatilityRegime: 'low' } })]);
    expect(buckets.find((b) => b.label === 'bullish')!.winRatePct).toBeNull();
  });
});

describe('sampleEquity', () => {
  const long = Array.from({ length: 10_000 }, (_, i) => point(i, 1_000_000 + Math.sin(i / 50) * 50_000));

  it('returns the curve untouched when it fits the budget', () => {
    const short = long.slice(0, 100);
    expect(sampleEquity(short, new Set())).toBe(short);
  });

  it('stays within budget while keeping the endpoints and the extremes', () => {
    const sampled = sampleEquity(long, new Set());
    expect(sampled.length).toBeLessThanOrEqual(4_100);
    expect(sampled[0].sequence).toBe(0);
    expect(sampled[sampled.length - 1].sequence).toBe(long.length - 1);

    const maxValue = Math.max(...long.map((p) => p.portfolioValue));
    const minValue = Math.min(...long.map((p) => p.portfolioValue));
    expect(sampled.some((p) => p.portfolioValue === maxValue)).toBe(true);
    expect(sampled.some((p) => p.portfolioValue === minValue)).toBe(true);
  });

  it('always keeps the bars a trade touched, so the chart and the table agree', () => {
    const pinned = new Set([1, 3, 7, 4_321, 9_998]);
    const sampled = sampleEquity(long, pinned);
    const kept = new Set(sampled.map((p) => p.sequence));
    for (const i of pinned) expect(kept.has(i)).toBe(true);
  });

  it('returns points in ascending order with no duplicates', () => {
    const sampled = sampleEquity(long, new Set([5, 5, 900]));
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i].sequence).toBeGreaterThan(sampled[i - 1].sequence);
    }
  });
});
