/**
 * The structured post-trade review: EXPECTED → ACTUAL → DIFFERENCE → WHY →
 * LESSON.
 *
 * Pure and dependency-free, like `execution-policy.ts` and
 * `execution-drawdown.ts`, and for the same reason: this is the input to the
 * learning pipeline, and a reviewer must be able to assert what a given trade
 * concludes without a database or a market.
 *
 * ## Why this is stored rather than computed on read
 *
 * It has to say what was expected AT THE TIME. A profile's risk percentages get
 * retuned, a strategy gets a new version, and a view recomputing this would
 * silently rewrite the history of every past trade to match today's
 * configuration — the same reasoning that makes `ExecutionJournal` a snapshot
 * rather than a view.
 *
 * ## What it is careful not to claim
 *
 * Three separations do the real work here, because collapsing any of them
 * teaches the wrong lesson:
 *
 *   · P&L is not thesis correctness. A trade can be right and lose (stopped on
 *     a retrace before running) or wrong and win (a chop that drifted into the
 *     target). `thesisCorrect` is measured on the FAVOURABLE EXCURSION — did
 *     the market ever actually do what the read said — never on the result.
 *
 *   · A missing measurement is not a zero. Every field is null when its input
 *     was absent, and `why` says so rather than reporting a confident 0.
 *
 *   · An observation is not a diagnosis. `why` states what the numbers show
 *     ("87% of the peak was given back"); it does not assert a single cause,
 *     because one trade cannot distinguish a loose trail from an unlucky
 *     retrace. That is the daily cycle's job, over many trades.
 */

/** The R-multiple of favourable excursion at which the market is taken to have
 *  done what the thesis said. One full risk unit — the plan's own yardstick. */
export const THESIS_CONFIRMED_R = 1;

/** Below this the position essentially never worked. */
export const THESIS_FAILED_R = 0.25;

export interface TradeExpectation {
  /** The premium the plan expected to pay. */
  plannedEntryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  /** Money the plan was willing to lose at the stop. The R denominator. */
  riskBudget: number | null;
  rewardTarget: number | null;
  confidence: number;
  strategyName: string | null;
  regime: string | null;
  bias: string | null;
}

export interface TradeActual {
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  realizedPnl: number;
  rMultiple: number | null;
  exitReason: string;
  holdingSeconds: number | null;
  result: string;
  /** Best premium the position ever saw. Null when never sampled. */
  mfePrice: number | null;
  /** Worst premium the position ever saw. Null when never sampled. */
  maePrice: number | null;
}

export interface ExcursionRead {
  mfePrice: number | null;
  maePrice: number | null;
  mfeAmount: number | null;
  maeAmount: number | null;
  mfeR: number | null;
  maeR: number | null;
  /**
   * Fraction of the peak unrealised gain that was not realised, 0–1.
   *
   * Null when the position never went favourable — "gave back none of nothing"
   * is not 0% efficiency, it is a different situation entirely.
   */
  giveBackPct: number | null;
}

export interface PostTradeAnalysis {
  expected: {
    entry: number | null;
    stop: number | null;
    target: number | null;
    riskBudget: number | null;
    rewardTarget: number | null;
    confidence: number;
    plannedRR: number | null;
    strategy: string | null;
    regime: string | null;
    bias: string | null;
  };
  actual: {
    entry: number;
    exit: number | null;
    realizedPnl: number;
    rMultiple: number | null;
    exitReason: string;
    holdingSeconds: number | null;
    result: string;
    mfeR: number | null;
    maeR: number | null;
  };
  difference: {
    /** Actual entry minus planned entry, in premium points. Positive = paid up. */
    entrySlippage: number | null;
    /** Realized R minus the planned reward in R. */
    rVsPlanned: number | null;
    /** Peak R minus realized R — what the management left on the table. */
    unrealisedPeakGap: number | null;
    giveBackPct: number | null;
  };
  /** What the numbers show. Observations, never a single asserted cause. */
  why: string[];
  /** One sentence, for the daily cycle and the console row. */
  lesson: string;
  /**
   * Did the market do what the read said, independent of P&L?
   *
   * True at ≥1R favourable excursion, false below 0.25R, null in between (the
   * ambiguous band) and null when the excursion could not be measured. A
   * forced boolean here would make every ambiguous trade vote in the averages.
   */
  thesisCorrect: boolean | null;
  /**
   * Confidence at entry minus what the result justified, in points.
   *
   * Crude per trade by construction — a single outcome cannot grade a
   * probability. It is meaningful only in aggregate, where a persistently
   * positive mean says the agent is systematically overconfident.
   */
  confidenceError: number | null;
}

/**
 * Excursions in money and in R.
 *
 * Long options only, which is what makes this arithmetic simple and is enforced
 * upstream by the constant `side = 'BUY'`: favourable is always UP from entry
 * and adverse always DOWN, so there is no direction term to get wrong.
 */
export function computeExcursions(args: {
  entryPrice: number;
  quantity: number;
  mfePrice: number | null;
  maePrice: number | null;
  riskBudget: number | null;
  realizedPnl: number;
}): ExcursionRead {
  const { entryPrice, quantity, mfePrice, maePrice, riskBudget } = args;

  // Clamped at zero: the high-water mark can equal the entry (a position that
  // only ever fell), and a negative "favourable" excursion is not a thing.
  const mfeAmount = mfePrice == null ? null : round2(Math.max(0, mfePrice - entryPrice) * quantity);
  const maeAmount = maePrice == null ? null : round2(Math.max(0, entryPrice - maePrice) * quantity);

  const usableBudget = riskBudget != null && riskBudget > 0 ? riskBudget : null;
  const mfeR = mfeAmount == null || usableBudget == null ? null : round3(mfeAmount / usableBudget);
  const maeR = maeAmount == null || usableBudget == null ? null : round3(maeAmount / usableBudget);

  // Null rather than 0 when the position never went favourable: there was no
  // peak to give back, which is a different fact from having kept all of one.
  const giveBackPct =
    mfeAmount == null || mfeAmount <= 0
      ? null
      : round3(Math.min(1, Math.max(0, (mfeAmount - args.realizedPnl) / mfeAmount)));

  return {
    mfePrice: mfePrice == null ? null : round2(mfePrice),
    maePrice: maePrice == null ? null : round2(maePrice),
    mfeAmount,
    maeAmount,
    mfeR,
    maeR,
    giveBackPct,
  };
}

export function analysePostTrade(args: {
  expected: TradeExpectation;
  actual: TradeActual;
  excursions: ExcursionRead;
}): PostTradeAnalysis {
  const { expected, actual, excursions } = args;

  const plannedRR =
    expected.riskBudget != null && expected.riskBudget > 0 && expected.rewardTarget != null
      ? round3(expected.rewardTarget / expected.riskBudget)
      : null;

  const entrySlippage =
    expected.plannedEntryPrice == null ? null : round2(actual.entryPrice - expected.plannedEntryPrice);

  const rVsPlanned =
    actual.rMultiple == null || plannedRR == null ? null : round3(actual.rMultiple - plannedRR);

  const unrealisedPeakGap =
    excursions.mfeR == null || actual.rMultiple == null ? null : round3(excursions.mfeR - actual.rMultiple);

  const thesisCorrect = judgeThesis(excursions.mfeR);

  const confidenceError =
    actual.result === 'WIN' || actual.result === 'LOSS'
      ? round3(expected.confidence - (actual.result === 'WIN' ? 100 : 0))
      : null;

  const why = explain({ expected, actual, excursions, entrySlippage, thesisCorrect });

  return {
    expected: {
      entry: expected.plannedEntryPrice,
      stop: expected.stopPrice,
      target: expected.targetPrice,
      riskBudget: expected.riskBudget,
      rewardTarget: expected.rewardTarget,
      confidence: expected.confidence,
      plannedRR,
      strategy: expected.strategyName,
      regime: expected.regime,
      bias: expected.bias,
    },
    actual: {
      entry: round2(actual.entryPrice),
      exit: actual.exitPrice == null ? null : round2(actual.exitPrice),
      realizedPnl: round2(actual.realizedPnl),
      rMultiple: actual.rMultiple,
      exitReason: actual.exitReason,
      holdingSeconds: actual.holdingSeconds,
      result: actual.result,
      mfeR: excursions.mfeR,
      maeR: excursions.maeR,
    },
    difference: {
      entrySlippage,
      rVsPlanned,
      unrealisedPeakGap,
      giveBackPct: excursions.giveBackPct,
    },
    why,
    lesson: lessonFrom({ actual, excursions, thesisCorrect }),
    thesisCorrect,
    confidenceError,
  };
}

/** ≥1R favourable = the market did it; <0.25R = it never worked; else unknown. */
function judgeThesis(mfeR: number | null): boolean | null {
  if (mfeR == null) return null;
  if (mfeR >= THESIS_CONFIRMED_R) return true;
  if (mfeR < THESIS_FAILED_R) return false;
  return null;
}

function explain(args: {
  expected: TradeExpectation;
  actual: TradeActual;
  excursions: ExcursionRead;
  entrySlippage: number | null;
  thesisCorrect: boolean | null;
}): string[] {
  const { actual, excursions, entrySlippage, thesisCorrect } = args;
  const why: string[] = [];

  if (excursions.mfeR == null || excursions.maeR == null) {
    why.push(
      'Excursion could not be measured for this trade, so how far it travelled in either direction is unknown — not zero.',
    );
  }

  if (thesisCorrect === true) {
    why.push(
      `The market did move as the read described: favourable excursion reached ${fmtR(excursions.mfeR)}, ` +
        `at or beyond the one risk unit that counts as confirmation.`,
    );
  } else if (thesisCorrect === false) {
    why.push(
      `The position never worked: favourable excursion peaked at ${fmtR(excursions.mfeR)}, ` +
        `below the ${THESIS_FAILED_R}R floor, so the entry was into immediate adverse movement rather than an early exit.`,
    );
  } else if (excursions.mfeR != null) {
    why.push(
      `Favourable excursion of ${fmtR(excursions.mfeR)} sits in the ambiguous band ` +
        `(${THESIS_FAILED_R}R–${THESIS_CONFIRMED_R}R): the read was neither confirmed nor refuted by the move.`,
    );
  }

  // The management question: how much of the peak survived to the close.
  if (excursions.giveBackPct != null && excursions.giveBackPct >= 0.5 && (excursions.mfeR ?? 0) >= THESIS_CONFIRMED_R) {
    why.push(
      `${pct(excursions.giveBackPct)} of the peak unrealised gain was given back before the ${actual.exitReason} exit ` +
        `— the thesis worked and the exit, not the entry, decided the result.`,
    );
  } else if (excursions.giveBackPct != null && excursions.giveBackPct <= 0.2 && actual.realizedPnl > 0) {
    why.push(`The exit captured ${pct(1 - excursions.giveBackPct)} of the peak unrealised gain.`);
  }

  // How close the stop came, on trades that ultimately worked.
  if (excursions.maeR != null && excursions.maeR >= 0.75 && actual.realizedPnl > 0) {
    why.push(
      `Adverse excursion reached ${fmtR(excursions.maeR)} before it turned — the position came close to its stop on the way to a profit.`,
    );
  }

  if (entrySlippage != null && Math.abs(entrySlippage) >= 0.5) {
    why.push(
      entrySlippage > 0
        ? `The entry filled ${entrySlippage.toFixed(2)} points worse than the fill model predicted.`
        : `The entry filled ${Math.abs(entrySlippage).toFixed(2)} points better than the fill model predicted.`,
    );
  }

  if (actual.exitReason === 'SQUARE_OFF') {
    why.push('The session ended before the plan resolved: neither the stop nor the target was reached.');
  }
  if (actual.exitReason === 'EMERGENCY') {
    why.push('Closed defensively — the position could not be managed (no price, a dead feed, or a closed session), not on a market signal.');
  }
  if (actual.exitReason === 'KILL_SWITCH') {
    why.push('Closed on an operator instruction, so this outcome measures the operator’s decision and not the strategy’s.');
  }

  return why;
}

function lessonFrom(args: {
  actual: TradeActual;
  excursions: ExcursionRead;
  thesisCorrect: boolean | null;
}): string {
  const { actual, excursions, thesisCorrect } = args;

  // An operator-ordered close teaches nothing about the strategy, and letting
  // it into the averages would be the loudest wrong lesson available.
  if (actual.exitReason === 'KILL_SWITCH') {
    return 'Operator-ordered exit — excluded from strategy judgement, since the position was not allowed to resolve.';
  }
  if (actual.exitReason === 'EMERGENCY') {
    return 'Defensive exit on an unmanageable position — review the data path, not the strategy.';
  }
  if (thesisCorrect === true && excursions.giveBackPct != null && excursions.giveBackPct >= 0.5) {
    return 'The read was right and the exit gave most of it back — this is a management question, not a selection one.';
  }
  if (thesisCorrect === true && actual.realizedPnl > 0) {
    return 'The read was confirmed by the move and the exit kept most of it; repeat conditions are worth identifying.';
  }
  if (thesisCorrect === false) {
    return 'The market never moved as described — this is a setup-selection question, and the exit performed as designed.';
  }
  if (actual.exitReason === 'SQUARE_OFF') {
    return 'Unresolved at the close — the setup may need a holding period the session could not provide.';
  }
  return 'No single lesson is supported by this trade alone; it contributes to its bucket rather than to a conclusion.';
}

function fmtR(r: number | null): string {
  return r == null ? 'an unmeasured amount' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
