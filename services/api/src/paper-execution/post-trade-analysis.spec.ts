import { describe, expect, it } from 'vitest';
import {
  THESIS_CONFIRMED_R,
  analysePostTrade,
  computeExcursions,
  type TradeActual,
  type TradeExpectation,
} from './post-trade-analysis';

const EXPECTED: TradeExpectation = {
  plannedEntryPrice: 100,
  stopPrice: 90,
  targetPrice: 130,
  riskBudget: 10_000,
  rewardTarget: 30_000,
  confidence: 78,
  strategyName: 'liquidity-sweep-reversal',
  regime: 'trending',
  bias: 'bullish',
};

/** A losing stop-out that never worked, unless overridden. */
const ACTUAL: TradeActual = {
  entryPrice: 100,
  exitPrice: 90,
  quantity: 1_000,
  realizedPnl: -10_000,
  rMultiple: -1,
  exitReason: 'STOP',
  holdingSeconds: 600,
  result: 'LOSS',
  mfePrice: 101,
  maePrice: 90,
};

function analyse(expected: Partial<TradeExpectation> = {}, actual: Partial<TradeActual> = {}) {
  const e = { ...EXPECTED, ...expected };
  const a = { ...ACTUAL, ...actual };
  const excursions = computeExcursions({
    entryPrice: a.entryPrice,
    quantity: a.quantity,
    mfePrice: a.mfePrice,
    maePrice: a.maePrice,
    riskBudget: e.riskBudget,
    realizedPnl: a.realizedPnl,
  });
  return analysePostTrade({ expected: e, actual: a, excursions });
}

describe('computeExcursions', () => {
  it('measures favourable and adverse excursion in money and in R', () => {
    // Entry 100, peak 115, trough 95, 1000 qty, 10,000 risk budget.
    const read = computeExcursions({
      entryPrice: 100,
      quantity: 1_000,
      mfePrice: 115,
      maePrice: 95,
      riskBudget: 10_000,
      realizedPnl: 5_000,
    });
    expect(read.mfeAmount).toBe(15_000);
    expect(read.maeAmount).toBe(5_000);
    expect(read.mfeR).toBe(1.5);
    expect(read.maeR).toBe(0.5);
  });

  it('clamps at zero rather than reporting a negative favourable excursion', () => {
    // A position that only ever fell: the high-water mark equals the entry.
    const read = computeExcursions({
      entryPrice: 100,
      quantity: 100,
      mfePrice: 100,
      maePrice: 80,
      riskBudget: 2_000,
      realizedPnl: -2_000,
    });
    expect(read.mfeAmount).toBe(0);
    expect(read.maeAmount).toBe(2_000);
  });

  it('reports give-back as NULL, not 0%, when the position never went favourable', () => {
    // "Gave back none of nothing" is a different fact from "kept all of it",
    // and a 0 here would read as a perfectly efficient exit in the averages.
    const read = computeExcursions({
      entryPrice: 100,
      quantity: 100,
      mfePrice: 100,
      maePrice: 90,
      riskBudget: 1_000,
      realizedPnl: -1_000,
    });
    expect(read.giveBackPct).toBeNull();
  });

  it('computes give-back for a trade that peaked and handed it back', () => {
    // Peak +20,000, closed +2,000 -> 90% given back.
    const read = computeExcursions({
      entryPrice: 100,
      quantity: 1_000,
      mfePrice: 120,
      maePrice: 99,
      riskBudget: 10_000,
      realizedPnl: 2_000,
    });
    expect(read.mfeAmount).toBe(20_000);
    expect(read.giveBackPct).toBe(0.9);
  });

  it('is null in R when the risk budget is missing or zero — an unknown denominator', () => {
    const noBudget = computeExcursions({
      entryPrice: 100, quantity: 100, mfePrice: 110, maePrice: 95, riskBudget: null, realizedPnl: 0,
    });
    expect(noBudget.mfeAmount).toBe(1_000);
    expect(noBudget.mfeR).toBeNull();
    expect(noBudget.maeR).toBeNull();

    const zeroBudget = computeExcursions({
      entryPrice: 100, quantity: 100, mfePrice: 110, maePrice: 95, riskBudget: 0, realizedPnl: 0,
    });
    expect(zeroBudget.mfeR).toBeNull();
  });

  it('is null when the excursion was never sampled, rather than zero', () => {
    const read = computeExcursions({
      entryPrice: 100, quantity: 100, mfePrice: null, maePrice: null, riskBudget: 1_000, realizedPnl: 0,
    });
    expect(read.mfePrice).toBeNull();
    expect(read.mfeAmount).toBeNull();
    expect(read.mfeR).toBeNull();
    expect(read.maeR).toBeNull();
  });
});

describe('analysePostTrade — P&L is not thesis correctness', () => {
  it('a LOSS whose market did move as read is thesis-CORRECT', () => {
    // Peaked +2R, then reversed and stopped out. The read was right; the
    // management decided the result. Judging this by P&L teaches the agent to
    // stop taking a setup that works.
    const a = analyse({}, { mfePrice: 120, maePrice: 90, realizedPnl: -10_000, rMultiple: -1, result: 'LOSS' });
    expect(a.actual.mfeR).toBe(2);
    expect(a.thesisCorrect).toBe(true);
    expect(a.actual.result).toBe('LOSS');
    expect(a.why.join(' ')).toContain('did move as the read described');
  });

  it('a WIN that never really worked is not credited with a correct thesis', () => {
    // Drifted to a small profit having peaked only +0.1R.
    const a = analyse({}, { mfePrice: 101, maePrice: 98, realizedPnl: 1_000, rMultiple: 0.1, result: 'WIN' });
    expect(a.thesisCorrect).toBe(false);
  });

  it('leaves the ambiguous band UNKNOWN rather than forcing a boolean', () => {
    // +0.5R peak: between the 0.25R failure floor and the 1R confirmation bar.
    const a = analyse({}, { mfePrice: 105, maePrice: 95 });
    expect(a.actual.mfeR).toBe(0.5);
    expect(a.thesisCorrect).toBeNull();
    expect(a.why.join(' ')).toContain('ambiguous band');
  });

  it('reports thesis correctness as UNKNOWN when the excursion was never sampled', () => {
    const a = analyse({}, { mfePrice: null, maePrice: null });
    expect(a.thesisCorrect).toBeNull();
    expect(a.why.join(' ')).toContain('not zero');
  });

  it('confirms the thesis exactly at the 1R bar', () => {
    const a = analyse({}, { mfePrice: 110, maePrice: 95 });
    expect(a.actual.mfeR).toBe(THESIS_CONFIRMED_R);
    expect(a.thesisCorrect).toBe(true);
  });
});

describe('analysePostTrade — the management question', () => {
  it('names give-back when a working thesis was handed back', () => {
    const a = analyse({}, { mfePrice: 130, maePrice: 99, realizedPnl: 3_000, rMultiple: 0.3, result: 'WIN', exitReason: 'TRAIL' });
    expect(a.difference.giveBackPct).toBe(0.9);
    expect(a.difference.unrealisedPeakGap).toBe(2.7); // peaked 3R, kept 0.3R
    expect(a.why.join(' ')).toContain('given back');
    expect(a.lesson).toContain('management question');
  });

  it('credits an exit that kept most of the peak', () => {
    const a = analyse({}, { mfePrice: 130, maePrice: 99, realizedPnl: 28_000, rMultiple: 2.8, result: 'WIN', exitReason: 'TARGET' });
    expect(a.why.join(' ')).toContain('captured');
    expect(a.lesson).toContain('repeat conditions');
  });

  it('notes when the stop was nearly hit on the way to a profit', () => {
    const a = analyse({}, { mfePrice: 130, maePrice: 92, realizedPnl: 25_000, rMultiple: 2.5, result: 'WIN', exitReason: 'TARGET' });
    expect(a.actual.maeR).toBe(0.8);
    expect(a.why.join(' ')).toContain('came close to its stop');
  });

  it('says a setup that never worked is a SELECTION problem, not an exit one', () => {
    const a = analyse({}, { mfePrice: 100.5, maePrice: 90 });
    expect(a.thesisCorrect).toBe(false);
    expect(a.lesson).toContain('setup-selection');
  });
});

describe('analysePostTrade — exits that teach nothing about the strategy', () => {
  it('excludes an operator KILL_SWITCH close from strategy judgement', () => {
    const a = analyse({}, { exitReason: 'KILL_SWITCH', mfePrice: 105, maePrice: 98 });
    expect(a.lesson).toContain('Operator-ordered');
    expect(a.lesson).toContain('excluded from strategy judgement');
    expect(a.why.join(' ')).toContain('not the strategy');
  });

  it('points an EMERGENCY exit at the data path rather than the strategy', () => {
    const a = analyse({}, { exitReason: 'EMERGENCY' });
    expect(a.lesson).toContain('data path');
  });

  it('describes an unresolved SQUARE_OFF as a holding-period question', () => {
    const a = analyse({}, { exitReason: 'SQUARE_OFF', mfePrice: 105, maePrice: 96, realizedPnl: 2_000, rMultiple: 0.2, result: 'WIN' });
    expect(a.why.join(' ')).toContain('session ended');
    expect(a.lesson).toContain('holding period');
  });
});

describe('analysePostTrade — expected vs actual', () => {
  it('records entry slippage against the price the plan was built on', () => {
    const a = analyse({ plannedEntryPrice: 100 }, { entryPrice: 102 });
    expect(a.difference.entrySlippage).toBe(2);
    expect(a.why.join(' ')).toContain('worse than the fill model predicted');
  });

  it('reports a better-than-modelled fill as negative slippage', () => {
    const a = analyse({ plannedEntryPrice: 100 }, { entryPrice: 98.5 });
    expect(a.difference.entrySlippage).toBe(-1.5);
    expect(a.why.join(' ')).toContain('better than the fill model predicted');
  });

  it('computes the planned reward:risk and the realized shortfall against it', () => {
    const a = analyse({}, { realizedPnl: 10_000, rMultiple: 1, result: 'WIN', mfePrice: 115, maePrice: 98 });
    expect(a.expected.plannedRR).toBe(3); // 30,000 reward / 10,000 risk
    expect(a.difference.rVsPlanned).toBe(-2); // made 1R against a 3R plan
  });

  it('carries the plan’s own context so a reviewer need not re-join the intent', () => {
    const a = analyse();
    expect(a.expected.strategy).toBe('liquidity-sweep-reversal');
    expect(a.expected.regime).toBe('trending');
    expect(a.expected.bias).toBe('bullish');
    expect(a.expected.confidence).toBe(78);
  });

  it('scores confidence error against the outcome, and only for decided trades', () => {
    expect(analyse({ confidence: 78 }, { result: 'LOSS' }).confidenceError).toBe(78);
    expect(analyse({ confidence: 78 }, { result: 'WIN' }).confidenceError).toBe(-22);
    // An OPEN or otherwise undecided trade has nothing to score against.
    expect(analyse({ confidence: 78 }, { result: 'OPEN' }).confidenceError).toBeNull();
  });

  it('survives a trade with no plan recorded, reporting nulls rather than zeros', () => {
    const a = analyse(
      { plannedEntryPrice: null, stopPrice: null, targetPrice: null, riskBudget: null, rewardTarget: null },
      { rMultiple: null, mfePrice: null, maePrice: null },
    );
    expect(a.difference.entrySlippage).toBeNull();
    expect(a.expected.plannedRR).toBeNull();
    expect(a.difference.rVsPlanned).toBeNull();
    expect(a.difference.unrealisedPeakGap).toBeNull();
    expect(a.thesisCorrect).toBeNull();
  });
});
