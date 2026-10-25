/**
 * Translating an index-space plan into option-premium space, and refusing it
 * when the premium cannot pay 1:3.
 *
 * ## The claim this file exists to stop
 *
 * "The index setup is 1:3, so the option trade is 1:3." It is not, and the
 * gap is not small. A long option's premium does not move point-for-point with
 * the index — it moves by delta, that delta itself changes as price moves
 * (gamma), and the whole premium bleeds with time (theta) whether or not the
 * index does anything at all. A structurally perfect 1:3 on NIFTY can be a
 * losing proposition on a contract that decays faster than the thesis resolves.
 *
 * So the tradable plan is computed in the premium the account will actually
 * pay and actually receive, and the 1:3 floor is applied THERE. The index plan
 * is kept beside it, unchanged, so the journal can show the translation rather
 * than assert it.
 *
 * ## The model, and its honest limits
 *
 *     premium(P) ≈ ltp + δ·ΔP + ½·γ·ΔP²  −  θ·days
 *
 * Second order in price, first order in time. That is a Taylor expansion of
 * the option's value around the current spot, which is exactly what the greeks
 * are — and using delta alone would be materially wrong for a 3R move, because
 * gamma is what makes a long option's reward convex and its risk concave.
 *
 * What it does NOT model: a change in implied volatility. A vega move can
 * dominate everything here, and nothing in a chain snapshot predicts one. That
 * is stated rather than hidden, and it is a reason the premium floor is applied
 * strictly rather than generously.
 *
 * ## Refusing is a first-class result
 *
 * Every function here can decline. A chain with a zero delta, a zero premium,
 * or a strike nobody is trading is not a contract this brain may express a
 * thesis through, and saying so is more useful than producing a number.
 */

import { REWARD_MULTIPLE } from './levels';
import type { TradeDirection } from './levels';

/** One side of one strike, as the option chain reports it. */
export interface OptionQuote {
  strike: number;
  optionType: 'CE' | 'PE';
  ltp: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  /** Per-day time decay, in premium points. Sign is normalised to positive. */
  theta: number;
  bid: number;
  ask: number;
}

/** Why a contract could not carry the thesis. */
export type PremiumRefusalReason =
  | 'no-chain'
  | 'no-tradable-strike'
  | 'premium-unusable'
  | 'delta-unusable'
  | 'premium-stop-non-positive'
  | 'premium-rr-below-floor';

export const PREMIUM_REFUSAL_LABELS: Record<PremiumRefusalReason, string> = {
  'no-chain': 'An option chain was available',
  'no-tradable-strike': 'A liquid strike exists near the money',
  'premium-unusable': 'The contract has a usable premium',
  'delta-unusable': 'The contract has a usable delta',
  'premium-stop-non-positive': 'The premium stop is above zero',
  'premium-rr-below-floor': 'The contract itself pays at least 1:3',
};

/** The plan as the account will actually experience it. */
export interface PremiumPlan {
  optionType: 'CE' | 'PE';
  strike: number;
  /** Premium paid at entry — the chain's last traded price. */
  entryPremium: number;
  /** Premium projected at the index stop. */
  stopPremium: number;
  /** Premium projected at the index target. */
  targetPremium: number;
  /** Premium projected at the index 1R level, where the ratchet arms. */
  firstRewardPremium: number;
  /** entry − stop, in premium points. This is 1R for the ACCOUNT. */
  riskPerUnit: number;
  /** target − entry, in premium points. */
  rewardPerUnit: number;
  /** The ratio that actually matters. */
  premiumRR: number;
  /** Greeks used, recorded so a translation can be audited after the fact. */
  delta: number;
  gamma: number;
  theta: number;
  /** Days of decay charged against the projection. */
  decayDays: number;
  /** The translation in words, with its numbers. */
  rationale: string[];
}

export type PremiumOutcome =
  | { ok: true; plan: PremiumPlan }
  | { ok: false; reason: PremiumRefusalReason; detail: string };

/**
 * How much time decay to charge against the projected levels.
 *
 * One day. The setups here are intraday-to-overnight, and charging zero would
 * make every projection flatter than reality — theta is the one greek that is
 * certain to act. Charging a full day against a trade that may resolve in an
 * hour is deliberately conservative: this is a floor test, and the failure to
 * avoid is admitting a trade that could not pay.
 */
export const DECAY_DAYS = 1;

/** The minimum open interest a strike must carry to be considered tradable. */
export const MIN_STRIKE_OI = 1000;

const tidy = (v: number): number => Math.round(v * 100) / 100;

/**
 * Project a contract's premium at an arbitrary index level.
 *
 * Floored at zero: an option cannot be worth less than nothing, and a quadratic
 * left unbounded will happily return a negative premium for a large adverse
 * move — which would then read as a profit on a short and as impossible risk
 * on a long.
 */
export function projectPremium(quote: OptionQuote, spot: number, indexPrice: number, decayDays = DECAY_DAYS): number {
  const move = indexPrice - spot;

  // Delta is integrated over the move rather than the raw ½γΔP² term being
  // added, and the delta is CLAMPED to its definitional bounds on the way.
  //
  // The naive expansion `δ·ΔP + ½γ·ΔP²` is only valid near the expansion
  // point, and it fails in a way that flatters the trade: for a large adverse
  // move the quadratic term dominates and the projection shows a long CALL
  // GAINING value as the index collapses. Measured with real chain greeks
  // (δ 0.52, γ 0.0004) a 5,000-point fall projected the premium UP from 154 to
  // 2,541. Sizing risk off that number would be worse than having no model.
  //
  // A call's delta cannot leave [0, 1] and a put's cannot leave [-1, 0], so
  // clamping the far-end delta and averaging gives the area under a bounded
  // delta curve — monotonic by construction, and therefore incapable of
  // turning an adverse move into a profit.
  const isCall = quote.optionType === 'CE';
  const farDelta = isCall
    ? Math.min(1, Math.max(0, quote.delta + quote.gamma * move))
    : Math.max(-1, Math.min(0, quote.delta + quote.gamma * move));
  const averageDelta = (quote.delta + farDelta) / 2;

  const decay = Math.abs(quote.theta) * decayDays;
  return Math.max(0, tidy(quote.ltp + averageDelta * move - decay));
}

/**
 * Which option side expresses a directional view on the index.
 *
 * A bearish index read is a BUY of a PUT, not a sell of anything — long
 * options only, so the account's risk is capped at the premium. Sentinel's own
 * execution path makes the same choice for the same reason, and it is the
 * distinction `computeMargin` exists to get right.
 */
export function optionSideFor(direction: TradeDirection): 'CE' | 'PE' {
  return direction === 'long' ? 'CE' : 'PE';
}

export interface StrikeSelectionInput {
  spot: number;
  direction: TradeDirection;
  quotes: OptionQuote[];
  /** How far from the money a strike may sit, as a fraction of spot. */
  maxMoneyness?: number;
  minOi?: number;
}

/**
 * Choose the contract to express the thesis through.
 *
 * Nearest-the-money among strikes that are actually being traded. ATM is
 * chosen deliberately over a cheaper OTM strike: delta near 0.5 keeps the
 * premium responsive to the index move the thesis is about, while a far OTM
 * contract is mostly a bet on volatility wearing a directional costume — and
 * its 1:3 would be arithmetic on a premium nobody will pay.
 */
export function selectStrike(input: StrikeSelectionInput): OptionQuote | null {
  const wantType = optionSideFor(input.direction);
  const maxMoneyness = input.maxMoneyness ?? 0.03;
  const minOi = input.minOi ?? MIN_STRIKE_OI;

  const usable = input.quotes.filter(
    (q) =>
      q.optionType === wantType &&
      q.ltp > 0 &&
      Math.abs(q.delta) > 0 &&
      q.oi >= minOi &&
      Math.abs(q.strike - input.spot) / input.spot <= maxMoneyness,
  );
  if (usable.length === 0) return null;

  return usable.reduce((best, q) =>
    Math.abs(q.strike - input.spot) < Math.abs(best.strike - input.spot) ? q : best,
  );
}

export interface TranslateInput {
  direction: TradeDirection;
  spot: number;
  /** The index-space plan, unchanged. */
  indexEntry: number;
  indexStop: number;
  indexTarget: number;
  indexFirstReward: number;
  quote: OptionQuote;
  /** Minimum premium-space reward:risk. Defaults to the 3R floor. */
  minRR?: number;
  decayDays?: number;
}

/**
 * Translate an index plan into premium space and apply the 1:3 floor there.
 *
 * Nothing in here adjusts a level to make the ratio pass. The index plan is an
 * input and leaves unchanged; the only outcomes are a premium plan that clears
 * the floor on its own, or a refusal.
 */
export function translateToPremium(input: TranslateInput): PremiumOutcome {
  const { quote, spot, direction } = input;
  const minRR = input.minRR ?? REWARD_MULTIPLE;
  const decayDays = input.decayDays ?? DECAY_DAYS;

  if (!(quote.ltp > 0)) {
    return { ok: false, reason: 'premium-unusable', detail: `${quote.strike} ${quote.optionType} has no traded premium.` };
  }
  if (!(Math.abs(quote.delta) > 0)) {
    return {
      ok: false,
      reason: 'delta-unusable',
      detail:
        `${quote.strike} ${quote.optionType} reports a zero delta, so no index move can be translated ` +
        `into a premium move. Refusing rather than assuming one.`,
    };
  }

  const entryPremium = tidy(quote.ltp);
  const stopPremium = projectPremium(quote, spot, input.indexStop, decayDays);
  const targetPremium = projectPremium(quote, spot, input.indexTarget, decayDays);
  const firstRewardPremium = projectPremium(quote, spot, input.indexFirstReward, decayDays);

  // A long option's premium risk is the premium it can lose. If the projection
  // says the stop level is worth AT LEAST what was paid, the translation has
  // produced a non-risk — which means the model, not the market, is wrong here.
  const riskPerUnit = tidy(entryPremium - stopPremium);
  if (!(riskPerUnit > 0)) {
    return {
      ok: false,
      reason: 'premium-stop-non-positive',
      detail:
        `Projected premium at the index stop (${stopPremium}) is not below the entry premium ` +
        `(${entryPremium}), so the contract expresses no measurable risk for this stop.`,
    };
  }

  const rewardPerUnit = tidy(targetPremium - entryPremium);
  const premiumRR = tidy(rewardPerUnit / riskPerUnit);

  if (!(premiumRR >= minRR)) {
    return {
      ok: false,
      reason: 'premium-rr-below-floor',
      detail:
        `The index plan is ${REWARD_MULTIPLE}R, but this contract pays ${premiumRR}:1 — ` +
        `premium ${entryPremium} → stop ${stopPremium} (risk ${riskPerUnit}), ` +
        `target ${targetPremium} (reward ${rewardPerUnit}), after ${decayDays}d of theta ` +
        `(${tidy(Math.abs(quote.theta) * decayDays)}). Refused: the structure is sound, the ` +
        `instrument cannot carry it.`,
    };
  }

  return {
    ok: true,
    plan: {
      optionType: quote.optionType,
      strike: quote.strike,
      entryPremium,
      stopPremium,
      targetPremium,
      firstRewardPremium,
      riskPerUnit,
      rewardPerUnit,
      premiumRR,
      delta: quote.delta,
      gamma: quote.gamma,
      theta: quote.theta,
      decayDays,
      rationale: [
        `Expressing a ${direction} on the index through ${quote.strike} ${quote.optionType} ` +
          `at ${entryPremium} (delta ${tidy(quote.delta)}, gamma ${quote.gamma}, OI ${quote.oi}).`,
        `Index stop ${input.indexStop} projects to premium ${stopPremium} — ${riskPerUnit} of premium risk.`,
        `Index target ${input.indexTarget} projects to premium ${targetPremium} — ${rewardPerUnit} of premium reward.`,
        `Premium reward:risk is ${premiumRR}:1, at or above the ${minRR}:1 floor, after charging ` +
          `${decayDays} day(s) of theta.`,
        `First reward (1R on the index, ${input.indexFirstReward}) projects to premium ${firstRewardPremium}.`,
      ],
    },
  };
}
