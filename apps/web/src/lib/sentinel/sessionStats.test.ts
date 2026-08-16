import { describe, expect, it } from 'vitest';
import { buildSessionStats, strategyIdsOf, EMPTY_SESSION_STATS } from './sessionStats';
import type { StrategyPerformance, WatchState, WatchSummary } from './sentinelPy';

/**
 * The session-stats grid is eight numbers in a row, which is exactly the shape
 * that makes a wrong one invisible: nothing on screen distinguishes a figure
 * derived from fifty outcomes from one derived from zero. These assertions
 * cover the three ways this arithmetic could quietly lie — double-counting
 * outcomes across watches that share a strategy, averaging expectancies
 * without weighting them, and reporting a rate with no sample behind it.
 */

function watch(state: WatchState, strategyId = 's1'): WatchSummary {
  return {
    id: `w-${state}-${strategyId}-${Math.random()}`,
    symbol: 'NIFTY',
    strike: '24350',
    optionType: 'CE',
    expiry: '2026-08-21',
    state,
    direction: null,
    entryPrice: null,
    strategyId,
  };
}

function performance(over: Partial<StrategyPerformance> = {}): StrategyPerformance {
  return {
    strategyId: 's1',
    funnel: { watches: 0, interactions: 0, confirmations: 0, entries: 0, outcomes: 0, rejections: 0 },
    outcomes: { reachedProjected: 0, reachedInvalidation: 0, stillOpen: 0 },
    r: { completed: 0, expectancy: null, best: null, worst: null, avgMfe: null, avgMae: null },
    sufficient: false,
    note: '',
    ...over,
  };
}

describe('buildSessionStats — watch states', () => {
  it('counts each state against the tile that names it', () => {
    const stats = buildSessionStats(
      [watch('IDLE'), watch('FORMING'), watch('CONFIRMED'), watch('IN_TRADE'), watch('EXITED')],
      [],
    );
    expect(stats.confirmed).toBe(1);
    expect(stats.openPositions).toBe(1);
    // IDLE and FORMING are both "still being evaluated"; EXITED is neither.
    expect(stats.watching).toBe(2);
  });

  it('reports zeros, not nulls, for counts with no watches', () => {
    // A count of nothing is zero. Only RATES are null when undecided — a "—"
    // in a count tile would read as "unknown" when the answer is "none".
    expect(buildSessionStats([], [])).toEqual(EMPTY_SESSION_STATS);
  });
});

describe('buildSessionStats — outcomes', () => {
  it('sums outcomes across strategies', () => {
    const stats = buildSessionStats(
      [],
      [
        performance({ strategyId: 's1', outcomes: { reachedProjected: 3, reachedInvalidation: 1, stillOpen: 0 } }),
        performance({ strategyId: 's2', outcomes: { reachedProjected: 1, reachedInvalidation: 2, stillOpen: 1 } }),
      ],
    );
    expect(stats.reachedProjected).toBe(4);
    expect(stats.reachedInvalidation).toBe(3);
    expect(stats.decided).toBe(7);
  });

  it('never counts one strategy twice because several watches share it', () => {
    // The regression this guards: performance is keyed by STRATEGY, and its
    // funnel already counts every watch that ran on it. Fetching per watch and
    // summing would report three outcomes where one happened.
    const shared = performance({ outcomes: { reachedProjected: 1, reachedInvalidation: 0, stillOpen: 0 } });
    const stats = buildSessionStats([watch('IDLE', 's1'), watch('IDLE', 's1'), watch('IDLE', 's1')], [shared]);
    expect(stats.reachedProjected).toBe(1);
  });
});

describe('buildSessionStats — the win rate never travels without its sample', () => {
  it('is null, not zero, when nothing has been decided', () => {
    // Zero would claim every outcome failed. Null is "no outcome yet".
    const stats = buildSessionStats([watch('FORMING')], [performance()]);
    expect(stats.winRate).toBeNull();
    expect(stats.decided).toBe(0);
  });

  it('carries the denominator alongside the rate', () => {
    const stats = buildSessionStats(
      [],
      [performance({ outcomes: { reachedProjected: 1, reachedInvalidation: 0, stillOpen: 0 } })],
    );
    expect(stats.winRate).toBe(1);
    // 100% over one outcome and 100% over forty are not the same claim, and
    // the tile cannot tell them apart without this.
    expect(stats.decided).toBe(1);
  });

  it('excludes still-open positions from the denominator', () => {
    // An open position has not failed. Counting it as decided would drag every
    // win rate down for as long as a trade is running.
    const stats = buildSessionStats(
      [],
      [performance({ outcomes: { reachedProjected: 1, reachedInvalidation: 1, stillOpen: 8 } })],
    );
    expect(stats.decided).toBe(2);
    expect(stats.winRate).toBe(0.5);
  });
});

describe('buildSessionStats — expectancy', () => {
  it('weights each strategy by the outcomes its mean came from', () => {
    // Unweighted, this would be (+3.0 + -1.0) / 2 = +1.00R — one lucky outcome
    // outvoting forty. Weighted: (3.0*1 + -1.0*39) / 40 = -0.90R.
    const stats = buildSessionStats(
      [],
      [
        performance({ strategyId: 's1', r: { completed: 1, expectancy: 3, best: 3, worst: 3, avgMfe: null, avgMae: null } }),
        performance({ strategyId: 's2', r: { completed: 39, expectancy: -1, best: 1, worst: -2, avgMfe: null, avgMae: null } }),
      ],
    );
    expect(stats.expectancy).toBeCloseTo(-0.9, 5);
    expect(stats.completed).toBe(40);
  });

  it('is null when no outcome has completed', () => {
    expect(buildSessionStats([], [performance()]).expectancy).toBeNull();
  });

  it('ignores a strategy that reports an expectancy with no completed outcomes', () => {
    // Guards a divide-by-zero weight and an expectancy conjured from nothing.
    const stats = buildSessionStats(
      [],
      [performance({ r: { completed: 0, expectancy: 5, best: null, worst: null, avgMfe: null, avgMae: null } })],
    );
    expect(stats.expectancy).toBeNull();
  });
});

describe('buildSessionStats — sample-size flag', () => {
  it('flags a thin sample while every strategy says its own history is insufficient', () => {
    expect(buildSessionStats([], [performance({ sufficient: false })]).thinSample).toBe(true);
  });

  it('clears once any strategy has enough history by the engine s own judgement', () => {
    const stats = buildSessionStats([], [performance({ sufficient: false }), performance({ sufficient: true })]);
    expect(stats.thinSample).toBe(false);
  });

  it('treats no strategies at all as a thin sample', () => {
    expect(buildSessionStats([watch('IDLE')], []).thinSample).toBe(true);
  });
});

describe('strategyIdsOf', () => {
  it('de-duplicates so each strategy is fetched once', () => {
    expect(strategyIdsOf([watch('IDLE', 's1'), watch('FORMING', 's1'), watch('IDLE', 's2')]).sort()).toEqual([
      's1',
      's2',
    ]);
  });

  it('returns nothing for no watches', () => {
    expect(strategyIdsOf([])).toEqual([]);
  });
});
