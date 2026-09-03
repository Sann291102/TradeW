/**
 * What a completed paper trade is allowed to change — and the arithmetic that
 * keeps it bounded.
 *
 * Pure, like every other decision module in this feature, so the safety claims
 * below are asserted rather than argued for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT MOVES A BAR, NOT A MEASUREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious design — scale a strategy's confidence by how well it has been
 * doing — is the wrong one, and not marginally. Confidence is produced by the
 * confidence engine from evidence; multiplying it afterwards means a recorded
 * "80%" that no observation produced, carried into the intent, the journal and
 * every calibration downstream. The record would be a forgery, and every
 * consumer would inherit it.
 *
 * So learning moves the ENTRY FLOOR the bucket must clear. The measurement is
 * left exactly as observed, and what changes is how much of it this
 * (agent, symbol, strategy, version, regime) bucket has earned the right to
 * act on. A losing bucket has to be more convincing; a winning one, on a
 * profile that set a stricter floor than the platform's, may relax back
 * toward — never past — the platform bar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HARD FLOOR IS UNREACHABLE FROM HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PLATFORM_CONFIDENCE_FLOOR` is 70 and is applied by `execution-policy.ts` as
 * a `Math.max` AFTER the adjustment. There is no value this module can emit,
 * and no row anyone can write into `StrategyCalibration`, that produces an
 * effective floor below 70. That is a structural property of the composition,
 * not a range check that a future edit could widen — `applyCalibration` below
 * takes the floor as an argument and clamps to it unconditionally.
 *
 * Nor can anything here touch a stop, a target, a trail, a risk budget, an
 * arming state or a data-freshness allowance. Those are recomputed from the
 * profile and the module constants on every single pass, so a calibration row
 * has no path to any of them.
 */

/** The bar no calibration may ever take an effective floor below. */
export const PLATFORM_CONFIDENCE_FLOOR = 70;

/**
 * Completed trades in a bucket before its results may move anything.
 *
 * Eight, reusing the floor `StrategyIntelligenceService.MIN_SAMPLE`, the
 * live-performance gate and `AdaptiveCalibrationService` already share. A
 * fourth independently-tuned threshold would be a fourth answer to one
 * question, and the four would drift apart silently.
 */
export const MIN_CALIBRATION_TRADES = 8;

/**
 * How far the floor may move, in whole confidence points.
 *
 * ASYMMETRIC, deliberately. Making a bucket HARDER is bounded at +15 because
 * a floor above 85 is effectively "never trade this again", which is a
 * decision an operator should make rather than an average. Making it EASIER is
 * bounded at −5 because loosening is the direction that costs money when the
 * sample is unrepresentative, and five points is a nudge rather than a licence.
 */
export const MAX_FLOOR_INCREASE = 15;
export const MAX_FLOOR_DECREASE = -5;

/** Confidence points per 1R of average result. */
const POINTS_PER_R = 5;

export interface CalibrationIdentity {
  agent: string;
  symbol: string;
  strategyId: string;
  strategyVersion: string;
  regime: string;
}

/**
 * The bucket key.
 *
 * ONE function, used by the writer and the reader, so the two cannot disagree
 * about what bucket a trade belongs to. Composing it at each call site is how
 * a reader ends up looking up `NIFTY|...` while the writer wrote `nifty|...`
 * and the loop silently never closes.
 */
export function calibrationKey(id: CalibrationIdentity): string {
  return [
    id.agent,
    id.symbol.toUpperCase(),
    id.strategyId,
    id.strategyVersion,
    id.regime,
  ].join('|');
}

export interface CalibrationSample {
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  grossPnl: number;
  /** Mean R across the bucket. Null when nothing has been recorded. */
  avgRMultiple: number | null;
}

/**
 * Fold one completed trade into a bucket's running totals.
 *
 * `rMultiple` is `realizedPnl / riskBudget` — the trade measured in units of
 * what it was ALLOWED to lose, which is the only comparable quantity across
 * positions of different sizes. A trade whose risk budget was not recorded
 * (a pre-2026-08-30 intent) contributes to the counts and the P&L but not to
 * the mean, because a null there is unknown rather than zero.
 */
export function foldOutcome(
  previous: CalibrationSample,
  outcome: { result: string; realizedPnl: number; rMultiple: number | null },
): CalibrationSample {
  const trades = previous.trades + 1;
  const wins = previous.wins + (outcome.result === 'WIN' ? 1 : 0);
  const losses = previous.losses + (outcome.result === 'LOSS' ? 1 : 0);
  const scratches = previous.scratches + (outcome.result === 'SCRATCH' ? 1 : 0);
  const grossPnl = round2(previous.grossPnl + outcome.realizedPnl);

  // Running mean over the trades that HAVE an R, which is not necessarily
  // `trades`. Recomputing it as `(prevMean × prevTrades + r) / trades` when
  // some of `prevTrades` had no R would silently weight the mean wrong.
  let avgRMultiple = previous.avgRMultiple;
  if (outcome.rMultiple != null && Number.isFinite(outcome.rMultiple)) {
    avgRMultiple =
      previous.avgRMultiple == null
        ? round3(outcome.rMultiple)
        : round3((previous.avgRMultiple * (previous.trades) + outcome.rMultiple) / trades);
  }

  return { trades, wins, losses, scratches, grossPnl, avgRMultiple };
}

/**
 * The floor adjustment this bucket has earned.
 *
 * Derived from average R rather than from win rate. A bucket that wins 70% of
 * the time and loses three times what it makes is a losing bucket, and win
 * rate alone would promote it.
 *
 * Returns 0 below the sample floor — deliberately, and this is the common
 * case for a long time. A calibration that starts adjusting after two trades
 * is a calibration that mostly measures noise.
 */
export function floorAdjustment(sample: CalibrationSample): number {
  if (sample.trades < MIN_CALIBRATION_TRADES) return 0;
  if (sample.avgRMultiple == null) return 0;
  // Negative average R → positive adjustment → a HIGHER bar.
  const raw = -sample.avgRMultiple * POINTS_PER_R;
  const rounded = raw >= 0 ? Math.floor(raw) : Math.ceil(raw);
  return Math.max(MAX_FLOOR_DECREASE, Math.min(MAX_FLOOR_INCREASE, rounded));
}

/**
 * The floor a decision must actually clear.
 *
 * The composition that makes the platform bar unreachable: whatever the
 * profile asked for, whatever the calibration learned, the answer is never
 * below `PLATFORM_CONFIDENCE_FLOOR`.
 */
export function applyCalibration(profileFloor: number, adjustment: number): number {
  return Math.max(PLATFORM_CONFIDENCE_FLOOR, profileFloor + adjustment);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
