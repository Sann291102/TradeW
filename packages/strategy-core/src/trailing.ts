/**
 * Trade management: the aggressive 1:1 trailing ratchet.
 *
 * ## Why this lives in `strategy-core` and not in the execution service
 *
 * Exit management is part of the decision, not part of the venue. A backtest
 * that trailed differently from the live engine would measure a strategy nobody
 * runs — the same split `strategy-core` was created to close, and it is far
 * easier to reintroduce here than at entry, because a trail feels like an
 * execution detail. It is not: it decides most of the realised R.
 *
 * ## The model
 *
 * Nothing happens until the trade has proven itself by reaching
 * `activationR`. Before that the initial structural stop stands, untouched —
 * a trade that has not yet paid anything has not earned a tighter stop, and
 * tightening early converts ordinary noise into a loss.
 *
 * At and beyond activation the stop ratchets in whole `stepR` increments,
 * always `lockR` behind the highest step the price has actually reached:
 *
 *     stop = entry + (stepsReached × stepR − lockR) × risk        (long)
 *
 * With the default 1.0 / 0.5 / 1.0 configuration and the worked example:
 *
 *     entry 79, stop 69  →  risk 10, so 1R = 89, 2R = 99, 3R = 109
 *
 *     price 89  (1R)  →  stop 84   (+0.5R locked)
 *     price 99  (2R)  →  stop 94   (+1.5R locked)
 *     price 109 (3R)  →  stop 104  (+2.5R locked)
 *
 * ## Two invariants that must never break
 *
 *  1. **A stop never moves backwards.** Not on a retrace, not on a data
 *     glitch, not on a restart that replays an old bar. Every caller is
 *     protected by the function itself rather than by remembering to check.
 *  2. **Steps are counted from the high-water mark, never from the current
 *     price.** Trailing off the live price would let a stop that had already
 *     ratcheted to +2.5R relax when price pulled back — which is precisely the
 *     giving-back this model exists to prevent.
 *
 * ## Deterministic, like everything else in the decision path
 *
 * The high-water mark is fed in by the caller and advanced from CLOSED bars,
 * so the same position replayed over the same bars produces the same stop
 * sequence in a backtest and in paper trading.
 */

import type { TradeDirection } from './levels';

export interface TrailingConfig {
  /** Minimum reward:risk an entry must offer. Not used by the ratchet; kept
   *  here so the whole trade-management contract is configured in one place. */
  initialRRMin: number;
  /** Unrealised R at which trailing begins. Below this the structural stop stands. */
  activationR: number;
  /** How far behind the reached step the stop sits, in R. */
  lockR: number;
  /** The ratchet increment, in R. */
  stepR: number;
}

/**
 * The default trade-management contract.
 *
 * Deliberately one exported object rather than four constants scattered across
 * services: a trail whose parameters live in three files is one that will be
 * changed in two of them.
 */
export const DEFAULT_TRAILING: TrailingConfig = {
  initialRRMin: 3.0,
  activationR: 1.0,
  lockR: 0.5,
  stepR: 1.0,
};

export interface TrailingInput {
  direction: TradeDirection;
  /** The fill the position actually opened at — not the planned entry. */
  entry: number;
  /** |entry − initial stop|. One R, in price. Must be > 0. */
  initialRisk: number;
  /** The stop currently in force. */
  currentStop: number;
  /**
   * The best price the trade has reached, from CLOSED bars.
   *
   * Passed in rather than derived from `lastPrice` so the ratchet cannot
   * relax on a pullback — see invariant 2.
   */
  highWaterPrice: number;
  config?: TrailingConfig;
}

export interface TrailingResult {
  /** The stop that should now be in force. Never worse than `currentStop`. */
  stop: number;
  /** True when the stop actually moved on this evaluation. */
  moved: boolean;
  /** Whole steps the high-water mark has reached. 0 before activation. */
  stepsReached: number;
  /** Unrealised R at the high-water mark. */
  highWaterR: number;
  /** R now locked in by the stop. Negative before activation. */
  lockedR: number;
  /** Why the stop is where it is, in words, with the numbers in it. */
  reason: string;
}

/** Round to 2dp without pretending to know the venue's tick size. */
function tidy(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Decide where the stop should be, given how far the trade has run.
 *
 * Pure and total: it performs no I/O, mutates nothing, and returns the current
 * stop unchanged rather than throwing when the inputs cannot support a
 * decision. A trade-management function that can throw is one that can leave a
 * live position unmanaged.
 */
export function updateTrailingStop(input: TrailingInput): TrailingResult {
  const cfg = input.config ?? DEFAULT_TRAILING;
  const { direction, entry, initialRisk, currentStop, highWaterPrice } = input;
  const long = direction === 'long';

  const hold = (reason: string, highWaterR = 0, stepsReached = 0): TrailingResult => ({
    stop: currentStop,
    moved: false,
    stepsReached,
    highWaterR,
    lockedR: initialRisk > 0 ? tidy((long ? currentStop - entry : entry - currentStop) / initialRisk) : 0,
    reason,
  });

  // A non-positive risk makes every R meaningless — 0R, ∞R, or a sign flip.
  // Holding the existing stop is the only safe answer.
  if (!(initialRisk > 0) || !Number.isFinite(initialRisk)) {
    return hold('Initial risk is not a positive number, so no R can be computed — stop held.');
  }
  if (!Number.isFinite(highWaterPrice) || !Number.isFinite(currentStop) || !Number.isFinite(entry)) {
    return hold('A price input is not finite — stop held.');
  }

  const highWaterR = (long ? highWaterPrice - entry : entry - highWaterPrice) / initialRisk;

  if (highWaterR < cfg.activationR) {
    return hold(
      `Best move is ${highWaterR.toFixed(2)}R, under the ${cfg.activationR}R activation — ` +
        `the initial structural stop stands.`,
      tidy(highWaterR),
    );
  }

  // Whole steps only. A trade at 1.9R has reached step 1, not 1.9: the ratchet
  // is a staircase, and paying out fractional steps would move the stop on
  // every tick and turn the trail into a moving average of the price.
  const stepsReached = Math.floor(highWaterR / cfg.stepR);
  const lockedR = stepsReached * cfg.stepR - cfg.lockR;
  const candidate = tidy(long ? entry + lockedR * initialRisk : entry - lockedR * initialRisk);

  // Invariant 1, enforced here so no caller has to remember it.
  const improves = long ? candidate > currentStop : candidate < currentStop;
  if (!improves) {
    return hold(
      `Ratchet at ${stepsReached} step(s) puts the stop at ${candidate}, no better than the ` +
        `${currentStop} already in force — stops never move backwards.`,
      tidy(highWaterR),
      stepsReached,
    );
  }

  return {
    stop: candidate,
    moved: true,
    stepsReached,
    highWaterR: tidy(highWaterR),
    lockedR: tidy(lockedR),
    reason:
      `Best move ${tidy(highWaterR)}R reached step ${stepsReached}; stop advanced from ${currentStop} ` +
      `to ${candidate}, locking ${tidy(lockedR)}R (${cfg.stepR}R step, ${cfg.lockR}R behind).`,
  };
}

/**
 * The high-water mark after observing one closed bar.
 *
 * Separate from the ratchet so the two can be tested independently, and so a
 * caller replaying bars cannot accidentally advance the mark from an unclosed
 * one — the input is a bar's extreme, not a tick.
 */
export function advanceHighWater(
  direction: TradeDirection,
  current: number,
  barHigh: number,
  barLow: number,
): number {
  return direction === 'long' ? Math.max(current, barHigh) : Math.min(current, barLow);
}
