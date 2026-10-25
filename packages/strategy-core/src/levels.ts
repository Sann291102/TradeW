/**
 * Structural level derivation and the 1:3 validator.
 *
 * ## The rule this file exists to enforce
 *
 * The setup justifies the entry and the stop FIRST. The target is then 3× the
 * resulting risk, and if that target is not reachable the setup is refused.
 *
 * The order matters and it is the whole point. The path this replaces sized
 * from account percentages — `riskPerTradePct` 3% and `rewardPerTradePct` 9%
 * of wallet equity — which yields a 1:3 ratio by arithmetic while the stop
 * lands wherever the arithmetic put it. That answers "how much am I willing to
 * lose?" and never "at what price is this idea wrong?", and those are
 * different questions. A stop derived from equity is the same distance whether
 * the market is quiet or violent, and it sits at a price no participant is
 * looking at.
 *
 * So: the anchor comes off the chart, the risk is measured from it, and 3R
 * follows. Nothing here may move a stop to make a ratio work.
 *
 * ## Why every threshold is in ATR, never percent or points
 *
 * One set of numbers has to serve NIFTY at ~23,600, BTC at ~78,000 and an MCX
 * gold lot at ~155,000, in three different currencies with three different
 * tick sizes. A stop "0.3% away" is a different claim about each; a stop "0.4
 * ATR away" is the same claim about all of them. ATR is the instrument's own
 * unit of normal movement, so thresholds expressed in it are portable by
 * construction — which is what lets the market-agnostic promise be real rather
 * than aspirational.
 *
 * A null ATR (fewer than two bars) is "cannot say" and refuses the trade. It
 * is never treated as zero: a zero ATR would make every check below pass.
 */

import { atr } from './indicators';
import { analyseStructure, findSwings } from './market-structure';
import type { MarketSnapshot } from './snapshot';
import type { SetupArchetype, SetupBias, SetupDefinition } from './setups';
import { DEFAULT_TRAILING, type TrailingConfig } from './trailing';

/**
 * The reward multiple every autonomous trade is planned at.
 *
 * Exactly 3, and a constant rather than a per-setup knob, because the brief is
 * a 1:3 engine and a per-setup multiple would let a setup that cannot reach 3R
 * quietly re-plan itself at 1.8R instead of being refused. Making it uniform
 * is what makes "R" comparable across markets and setups in the journal.
 */
export const REWARD_MULTIPLE = 3;

/**
 * How far beyond the structural level the stop sits, in ATR.
 *
 * A stop exactly ON the level is taken out by the wick that tests it — and
 * levels get tested, that is what makes them levels. A quarter of one bar's
 * average range is enough to sit outside the routine probe without turning the
 * invalidation into a different price.
 */
export const ANCHOR_BUFFER_ATR = 0.25;

/**
 * The smallest risk that is a real invalidation rather than noise.
 *
 * Below this the "stop" is inside a single bar's ordinary movement, so it
 * would be hit by the market doing nothing in particular. The trade would then
 * be decided by the spread and the wick, not by the thesis — and, worse, a
 * tiny denominator makes R meaningless: a 2-point risk turns a routine 6-point
 * drift into "+3R" and poisons the journal that learning reads.
 */
export const MIN_RISK_ATR = 0.4;

/**
 * The largest risk still worth expressing as one trade.
 *
 * Beyond this the structure being referenced is too far away for the current
 * volatility, which makes the 3R target (three times a very wide risk) a move
 * the instrument does not make in the available time. Refusing is correct;
 * moving the stop closer to make the sizing work would be inventing an
 * invalidation the setup never claimed.
 */
export const MAX_RISK_ATR = 2.5;

/**
 * The furthest a 3R target may sit and still be treated as reachable.
 *
 * The feasibility filter, and the reason it is separate from `MAX_RISK_ATR`:
 * risk and reward can each be individually reasonable while their sum asks the
 * market for a move it does not make. Six ATR is roughly a strong session's
 * total directional range on a 15-minute series, so a target beyond it is
 * asking for an exceptional day as the BASE case.
 */
export const MAX_TARGET_ATR = 6;

/** Why a structurally-sound-looking setup could not be turned into a plan. */
export type LevelRefusalReason =
  | 'no-directional-bias'
  | 'no-structural-anchor'
  | 'anchor-on-wrong-side'
  | 'atr-unavailable'
  | 'risk-below-noise-floor'
  | 'risk-exceeds-volatility-budget'
  | 'target-not-feasible';

/** Operator-facing labels, in the shape the policy layer already uses. */
export const LEVEL_REFUSAL_LABELS: Record<LevelRefusalReason, string> = {
  'no-directional-bias': 'Setup has a direction',
  'no-structural-anchor': 'Setup has a structural invalidation level',
  'anchor-on-wrong-side': 'Invalidation sits on the losing side of entry',
  'atr-unavailable': 'Volatility is measurable',
  'risk-below-noise-floor': 'Invalidation is outside routine noise',
  'risk-exceeds-volatility-budget': 'Invalidation is within reach of current volatility',
  'target-not-feasible': 'A 3R target is reachable in this volatility',
};

export type TradeDirection = 'long' | 'short';

export interface LevelAnchor {
  archetype: SetupArchetype;
  /** The structural price the stop is derived from, BEFORE the buffer. */
  level: number;
  /** What that price is, in words, with the number in it. */
  note: string;
}

export interface LevelPlan {
  direction: TradeDirection;
  entry: number;
  stop: number;
  target: number;
  /** |entry − stop|, in the analysed instrument's points. This is 1R. */
  riskPerUnit: number;
  /** |target − entry|. Equals `REWARD_MULTIPLE × riskPerUnit` by construction. */
  rewardPerUnit: number;
  plannedRR: number;
  anchor: LevelAnchor;
  atr: number;
  /** Risk and reward as ATR multiples — how the thresholds above were judged. */
  riskAtr: number;
  targetAtr: number;
  /**
   * The FIRST reward, at exactly 1R.
   *
   * Distinguished from `target` deliberately. The trade is only taken because
   * the structure supports the full 3R, but it is MANAGED in stages: 1R is
   * where the trade has proven itself and the ratchet begins. Carrying only
   * the final target would leave the management layer to rediscover this
   * number, and a level the plan does not state is a level nobody can audit.
   */
  firstRewardPrice: number;
  /** How this trade will be exited, decided BEFORE it may be entered. */
  exitPlan: ExitPlan;
  /** The derivation, in order, each line carrying its own numbers. */
  rationale: string[];
}

/**
 * The exit, decided before the entry.
 *
 * ## Why this is a required field and not an optional extra
 *
 * "Entry looks good, we'll work out the exit later" is the single most
 * expensive sentence in discretionary trading, and an engine can make it
 * structurally impossible to say. `LevelPlan` cannot be constructed without an
 * `ExitPlan`, so a candidate that reached the acceptance gate necessarily
 * already knows every way it intends to leave — before a single unit is
 * committed.
 *
 * Everything here is fixed at decision time and never renegotiated while the
 * position is open. Management may only execute this plan; it may not reopen
 * it, widen a stop, extend a target, or change strategy mid-trade.
 */
export interface ExitPlan {
  /** Where the thesis is dead. The same structural level the stop sits behind. */
  structuralInvalidation: string;
  /** Unrealised R at which the ratchet begins. */
  trailActivationR: number;
  /** How far behind the reached step the trailing stop sits, in R. */
  trailLockR: number;
  /** The ratchet increment, in R. */
  trailStepR: number;
  /**
   * Rule ids the position manager re-evaluates on every observation.
   *
   * The strategy's OWN exit rules, carried from the setup definition — so a
   * thesis that has stopped being true closes the trade even when neither the
   * stop nor the target has been touched.
   */
  invalidationRules: string[];
  /** Every way this trade is permitted to end, stated up front. */
  exits: string[];
  /** The plan in prose, for the journal and for a human reading it back. */
  summary: string;
}

export type LevelOutcome =
  | { ok: true; plan: LevelPlan }
  | { ok: false; reason: LevelRefusalReason; detail: string };

const refuse = (reason: LevelRefusalReason, detail: string): LevelOutcome => ({
  ok: false,
  reason,
  detail,
});

/** Round to a sane number of decimals without pretending to know tick size. */
function tidy(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The structural price this archetype's thesis dies at, before any buffer.
 *
 * Returns null when the snapshot does not contain the structure the setup
 * claims — which is a refusal, never a fallback. Substituting "a percentage
 * below entry" when the real anchor is missing would produce a plan whose stop
 * means nothing while looking identical to one whose stop means everything.
 */
export function findAnchor(
  archetype: SetupArchetype,
  direction: TradeDirection,
  snapshot: MarketSnapshot,
): LevelAnchor | null {
  const long = direction === 'long';
  const bars = snapshot.candles;
  const last = bars[bars.length - 1] ?? null;

  switch (archetype) {
    case 'range-break': {
      // The edge that was broken. `orb_reentry` — this setup's own declared
      // invalidation — fires on a close back through exactly this level, so
      // anchoring anywhere else would stop on a different claim than the one
      // the setup makes.
      const or = snapshot.openingRange;
      if (!or) return null;
      const level = long ? or.high : or.low;
      return {
        archetype,
        level,
        note: `Opening-range ${long ? 'high' : 'low'} at ${tidy(level)}; a close back inside the range is this setup's own invalidation`,
      };
    }

    case 'structure-shift': {
      // The swing that would un-break the structure. Deliberately NOT the
      // order block: `order_block_mitigated` means price is INSIDE the block
      // at entry, so a stop there would sit at or through the entry price.
      if (bars.length < 10) return null;
      const st = analyseStructure(bars);
      const swing = long ? st.lastSwingLow : st.lastSwingHigh;
      if (!swing) return null;
      return {
        archetype,
        level: swing.price,
        note: `Last swing ${long ? 'low' : 'high'} at ${tidy(swing.price)}; losing it un-breaks the structure this setup traded`,
      };
    }

    case 'pullback-swing': {
      // The pullback's own extreme — the nearest confirmed swing on the
      // losing side of price. "Nearest" rather than "last": in a trend the
      // most recent swing may be far below, and the pullback being joined is
      // the one just under the current price.
      const swings = findSwings(bars).filter((s) => (long ? s.kind === 'low' : s.kind === 'high'));
      const candidates = swings.filter((s) =>
        long ? s.price < snapshot.lastPrice : s.price > snapshot.lastPrice,
      );
      if (candidates.length === 0) return null;
      const swing = candidates.reduce((best, s) =>
        Math.abs(s.price - snapshot.lastPrice) < Math.abs(best.price - snapshot.lastPrice) ? s : best,
      );
      return {
        archetype,
        level: swing.price,
        note: `Pullback swing ${long ? 'low' : 'high'} at ${tidy(swing.price)}; through it the pullback was a reversal`,
      };
    }

    case 'sweep-reclaim': {
      // The extreme of the bar that took the liquidity. Trading back through
      // it means the sweep was a genuine break, which is the opposite of this
      // setup's thesis.
      if (!last) return null;
      const level = long ? last.low : last.high;
      return {
        archetype,
        level,
        note: `Sweep extreme at ${tidy(level)} on the rejection bar; trading back through it makes the sweep a real break`,
      };
    }

    case 'signal-bar': {
      if (!last) return null;
      const level = long ? last.low : last.high;
      return {
        archetype,
        level,
        note: `Signal bar ${long ? 'low' : 'high'} at ${tidy(level)}`,
      };
    }

    default:
      return null;
  }
}

/**
 * Turn a detected setup into an entry, a structural stop and a 3R target — or
 * refuse it and say which check failed.
 *
 * `entry` is the snapshot's live price. The engine places market orders, so
 * the honest planned entry is the price it would fill near; quoting a limit
 * the engine never sends would make every recorded slippage fictional.
 */
export function deriveLevels(
  setup: SetupDefinition,
  bias: SetupBias,
  snapshot: MarketSnapshot,
  trailing: TrailingConfig = DEFAULT_TRAILING,
): LevelOutcome {
  if (bias !== 'bullish' && bias !== 'bearish') {
    return refuse(
      'no-directional-bias',
      `${setup.name} resolved a ${bias} bias; a neutral read is not a weak buy and is never traded.`,
    );
  }

  const direction: TradeDirection = bias === 'bullish' ? 'long' : 'short';
  const long = direction === 'long';
  const entry = snapshot.lastPrice;

  const volatility = atr(snapshot.candles);
  if (volatility === null || !(volatility > 0)) {
    return refuse(
      'atr-unavailable',
      `ATR is unmeasurable from ${snapshot.candles.length} bar(s), so no threshold below can be judged.`,
    );
  }

  const anchor = findAnchor(setup.archetype, direction, snapshot);
  if (!anchor) {
    return refuse(
      'no-structural-anchor',
      `${setup.name} is a '${setup.archetype}' setup and the snapshot carries no such structure to anchor a stop to.`,
    );
  }

  // The buffer always moves the stop AWAY from entry, never toward it.
  const buffer = ANCHOR_BUFFER_ATR * volatility;
  const stop = tidy(long ? anchor.level - buffer : anchor.level + buffer);

  if (long ? stop >= entry : stop <= entry) {
    return refuse(
      'anchor-on-wrong-side',
      `A ${direction} from ${tidy(entry)} would need its stop below entry, but the ${setup.archetype} anchor puts it at ${stop}. The structure being referenced has already been passed.`,
    );
  }

  const riskPerUnit = tidy(Math.abs(entry - stop));
  const riskAtr = riskPerUnit / volatility;

  if (riskAtr < MIN_RISK_ATR) {
    return refuse(
      'risk-below-noise-floor',
      `Risk ${riskPerUnit} is ${riskAtr.toFixed(2)} ATR, under the ${MIN_RISK_ATR} floor — inside one bar's ordinary movement, so the stop would be hit by noise and every R computed from it would be inflated.`,
    );
  }

  if (riskAtr > MAX_RISK_ATR) {
    return refuse(
      'risk-exceeds-volatility-budget',
      `Risk ${riskPerUnit} is ${riskAtr.toFixed(2)} ATR, over the ${MAX_RISK_ATR} ceiling — the structure is too far away for current volatility to reach a 3R target from it.`,
    );
  }

  const rewardPerUnit = tidy(REWARD_MULTIPLE * riskPerUnit);
  const target = tidy(long ? entry + rewardPerUnit : entry - rewardPerUnit);
  const targetAtr = rewardPerUnit / volatility;
  // The first reward, at exactly 1R — where the trade has proven itself and
  // the ratchet begins. Stated in the plan rather than rediscovered later.
  const firstRewardPrice = tidy(long ? entry + riskPerUnit : entry - riskPerUnit);

  // ── THE EXIT, DECIDED BEFORE THE ENTRY ────────────────────────────────────
  //
  // Constructed here, inside the only function that can produce a plan, so a
  // candidate cannot reach the acceptance gate without one. Every way the
  // trade is permitted to end is enumerated now; management executes this and
  // may not renegotiate it.
  const exitPlan: ExitPlan = {
    structuralInvalidation: anchor.note,
    trailActivationR: trailing.activationR,
    trailLockR: trailing.lockR,
    trailStepR: trailing.stepR,
    invalidationRules: setup.exitRules,
    exits: [
      `Stop at ${stop} — the structural invalidation.`,
      `Target at ${target} — ${REWARD_MULTIPLE}R.`,
      `Trailing stop, armed at ${firstRewardPrice} (${trailing.activationR}R) and ratcheting ` +
        `${trailing.stepR}R at a time, ${trailing.lockR}R behind.`,
      setup.exitRules.length
        ? `Thesis invalidation: ${setup.exitRules.join(', ')}.`
        : 'No strategy exit rules declared.',
      'Session square-off, per the venue.',
    ],
    summary:
      `Risk ${riskPerUnit} to ${stop}. First reward ${firstRewardPrice} (1R) arms the ratchet; ` +
      `beyond it the stop advances ${trailing.stepR}R at a time, ${trailing.lockR}R behind the ` +
      `best move, and never backwards. Full target ${target} at ${REWARD_MULTIPLE}R. The trade ` +
      `also closes if ${setup.exitRules.length ? setup.exitRules.join(' or ') : 'the session ends'}.`,
  };

  if (targetAtr > MAX_TARGET_ATR) {
    return refuse(
      'target-not-feasible',
      `A 3R target sits ${rewardPerUnit} away, ${targetAtr.toFixed(2)} ATR, beyond the ${MAX_TARGET_ATR} reachability ceiling. The levels are sound; the move they require is not one this instrument is currently making.`,
    );
  }

  return {
    ok: true,
    plan: {
      direction,
      entry: tidy(entry),
      stop,
      target,
      riskPerUnit,
      rewardPerUnit,
      plannedRR: REWARD_MULTIPLE,
      anchor,
      atr: tidy(volatility),
      riskAtr: Number(riskAtr.toFixed(2)),
      targetAtr: Number(targetAtr.toFixed(2)),
      firstRewardPrice,
      exitPlan,
      rationale: [
        `${setup.name} resolved ${bias} from its ${setup.biasSource} read, so the trade is a ${direction}.`,
        anchor.note + '.',
        `Stop ${stop}, a ${ANCHOR_BUFFER_ATR} ATR (${tidy(buffer)}) buffer beyond that level so a routine test of it does not close the trade.`,
        `Entry ${tidy(entry)} against that stop is ${riskPerUnit} of risk — ${riskAtr.toFixed(2)} ATR, inside the ${MIN_RISK_ATR}–${MAX_RISK_ATR} band.`,
        `Target ${target} is ${REWARD_MULTIPLE}R (${rewardPerUnit}), ${targetAtr.toFixed(2)} ATR away and within the ${MAX_TARGET_ATR} ATR reachability ceiling.`,
      ],
    },
  };
}
