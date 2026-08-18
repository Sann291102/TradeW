import type { OptionChainEntry } from '@tradew/types';

/**
 * Three-strike evaluation for the paper execution loop.
 *
 * ## Why this is NOT on the observe contract
 *
 * `intelligence/contract-alignment.ts` records the rule this module lives under:
 * ranking contracts by attractiveness is a recommendation however it is phrased,
 * so nothing that reaches a trader may order strikes by preference. This module
 * does exactly that ordering — it picks one contract out of three — which is
 * precisely why it is reachable ONLY from `POST /execution/evaluate` (service
 * token, consumed by `services/api`'s paper-execution loop) and never from
 * `POST /observe`, the response `apps/web` renders.
 *
 * The distinction is not cosmetic. A selected strike shown to a trader is a
 * directive. The same selection, made for Sentinel's OWN paper account and
 * shown only to an operator in the admin console, is an audit record of what
 * the machine did with its own money. `ObserveResponse` is unchanged by this
 * file, and must stay that way.
 *
 * ## What "evaluated" means here
 *
 * Every number below is read from the live front-expiry chain the observation
 * was built on. Nothing is modelled, interpolated or defaulted: a leg the chain
 * did not price is reported unpriced and is disqualified, which is a different
 * outcome from a leg that priced at a premium too low to trade. Both are
 * recorded with the check that produced them, so a rejection is inspectable
 * rather than a verdict.
 */

/** One check that ran against a candidate. Mirrors the publication gate's shape. */
export interface CandidateCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export type StrikeRole = 'ITM' | 'ATM' | 'OTM';

export interface StrikeCandidate {
  role: StrikeRole;
  strike: number;
  optionType: 'CE' | 'PE';
  /** Live premium for this leg, or null when the chain did not price it. */
  premium: number | null;
  openInterest: number | null;
  volume: number | null;
  impliedVol: number | null;
  /**
   * Distance from spot in points, signed so that POSITIVE is in-the-money for
   * the side being evaluated. A CE 100 points below spot and a PE 100 points
   * above it are both `+100`: same economic position, same number.
   */
  moneyness: number | null;
  /** Passed every hard check — necessary to be selectable, not sufficient. */
  tradable: boolean;
  selected: boolean;
  reason: string;
  checks: CandidateCheck[];
}

export interface StrikeEvaluationPolicy {
  /** Reject a leg cheaper than this — a near-worthless contract is mostly noise. */
  minPremium: number;
  /** Reject a leg richer than this, so one position cannot consume the account. */
  maxPremium: number;
  minOpenInterest: number;
  minVolume: number;
}

export const DEFAULT_STRIKE_POLICY: StrikeEvaluationPolicy = {
  minPremium: 5,
  maxPremium: 1_000,
  minOpenInterest: 1_000,
  minVolume: 100,
};

export interface StrikeEvaluation {
  /** Ascending by strike, always three entries when a chain was available. */
  candidates: StrikeCandidate[];
  selected: StrikeCandidate | null;
  atmStrike: number | null;
  strikeStep: number | null;
  /** Set when no candidate could be selected; null on success. */
  unavailableReason: string | null;
}

/** NSE index conventions — the fallback when a chain is too sparse to infer a step. */
const STRIKE_INTERVALS: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
  SENSEX: 100,
  BANKEX: 100,
};

/**
 * The instrument's real strike step, taken as the MODAL gap between adjacent
 * listed strikes.
 *
 * Inferred from the chain rather than read from the table above because the
 * table is a convention and the chain is a fact: an exchange that revises a
 * step, or a symbol not in the table, would otherwise produce strikes that do
 * not trade — which reads as authoritative and is simply false. The table is
 * the fallback for a chain too sparse to infer from (< 3 strikes).
 */
export function inferStrikeStep(symbol: string, strikes: number[]): number | null {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  if (sorted.length >= 3) {
    const gaps = new Map<number, number>();
    for (let i = 1; i < sorted.length; i++) {
      const gap = Math.round(sorted[i] - sorted[i - 1]);
      if (gap > 0) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
    }
    let modal = 0;
    let best = 0;
    for (const [gap, count] of gaps) {
      // Ties break toward the SMALLER gap: a chain that lists every strike but
      // is missing a few rows produces both `step` and `2*step` at similar
      // counts, and the smaller one is the real listing increment.
      if (count > best || (count === best && gap < modal)) {
        modal = gap;
        best = count;
      }
    }
    if (modal > 0) return modal;
  }
  return STRIKE_INTERVALS[symbol.toUpperCase()] ?? null;
}

/** The listed strike nearest to spot — never a rounded number that may not trade. */
export function nearestListedStrike(strikes: number[], spot: number): number | null {
  if (!strikes.length || !Number.isFinite(spot) || spot <= 0) return null;
  return strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]);
}

/**
 * Evaluate the three candidate strikes for one side, and select one.
 *
 * ## The selection rule, stated plainly
 *
 * The at-the-money contract is the reference expression of a directional read:
 * it carries the most balanced delta-per-rupee of the three and is, on an index
 * chain, reliably the most liquid. So ATM is chosen when it passes every check,
 * and the ITM/OTM legs exist as FALLBACKS for the cases that actually occur —
 * an ATM leg the chain did not price, or one whose premium sits outside the
 * profile's band.
 *
 * This is deliberately a rule and not a score. A score over three contracts is
 * a ranking of instruments by attractiveness, which is the thing Rule 2 forbids
 * anywhere near a trader, and which would also be false precision here: the
 * inputs (premium, OI, volume) do not contain enough information to order three
 * strikes by expected outcome, and a number would imply they do.
 *
 * When ATM fails, the tie-break among survivors is distance from spot first
 * (the nearest surviving contract is the closest substitute for the one that
 * failed) and open interest second.
 */
export function evaluateStrikeCandidates(input: {
  symbol: string;
  spot: number;
  side: 'CE' | 'PE';
  /** Front-expiry entries, as `OptionChainRead.entries` supplies them. */
  chain: OptionChainEntry[];
  policy?: StrikeEvaluationPolicy;
}): StrikeEvaluation {
  const policy = input.policy ?? DEFAULT_STRIKE_POLICY;
  const { symbol, spot, side, chain } = input;

  const empty = (reason: string): StrikeEvaluation => ({
    candidates: [],
    selected: null,
    atmStrike: null,
    strikeStep: null,
    unavailableReason: reason,
  });

  if (!Number.isFinite(spot) || spot <= 0) {
    return empty('No underlying spot price was available, so no strike could be located.');
  }
  if (!chain.length) {
    return empty('No option chain was published for this instrument at evaluation time.');
  }

  const strikes = chain.map((e) => e.strike).filter((s) => Number.isFinite(s) && s > 0);
  const step = inferStrikeStep(symbol, strikes);
  const atm = nearestListedStrike(strikes, spot);
  if (atm == null || step == null) {
    return empty('The option chain was too sparse to establish an at-the-money strike and its step.');
  }

  // ITM/OTM are one step from ATM, in the direction that is in-the-money for
  // THIS side. A call gains as the market rises, so its in-the-money strike is
  // BELOW spot; a put's is above. Getting this backwards would silently select
  // the contract with the opposite exposure to the read.
  const itmStrike = side === 'CE' ? atm - step : atm + step;
  const otmStrike = side === 'CE' ? atm + step : atm - step;

  const wanted: Array<{ role: StrikeRole; strike: number }> = [
    { role: 'ITM', strike: itmStrike },
    { role: 'ATM', strike: atm },
    { role: 'OTM', strike: otmStrike },
  ];

  const byStrike = new Map(chain.map((e) => [e.strike, e]));
  const candidates: StrikeCandidate[] = wanted.map(({ role, strike }) =>
    buildCandidate({ role, strike, side, spot, entry: byStrike.get(strike), policy }),
  );

  const tradable = candidates.filter((c) => c.tradable);
  if (!tradable.length) {
    return {
      candidates: candidates.sort((a, b) => a.strike - b.strike),
      selected: null,
      atmStrike: atm,
      strikeStep: step,
      unavailableReason:
        `None of the three ${side} candidates around ${atm} passed evaluation — ` +
        candidates.map((c) => `${c.strike}: ${c.reason}`).join('; '),
    };
  }

  const atmCandidate = tradable.find((c) => c.role === 'ATM');
  const chosen =
    atmCandidate ??
    [...tradable].sort(
      (a, b) =>
        Math.abs(a.strike - spot) - Math.abs(b.strike - spot) ||
        (b.openInterest ?? 0) - (a.openInterest ?? 0),
    )[0];

  for (const candidate of candidates) {
    if (candidate === chosen) {
      candidate.selected = true;
      candidate.reason =
        candidate.role === 'ATM'
          ? `Selected — at-the-money ${side} at ${candidate.strike}, the reference contract for this read, and it passed every check.`
          : `Selected — the at-the-money leg did not pass, and ${candidate.strike} was the nearest surviving ${side} contract to spot ${spot.toFixed(2)}.`;
    } else if (candidate.tradable) {
      candidate.reason = `Not selected — tradable, but ${
        atmCandidate ? 'the at-the-money leg was preferred' : 'a contract closer to spot survived'
      }.`;
    }
    // A non-tradable candidate keeps the reason its failing check already gave
    // it: that sentence names WHICH check failed, and overwriting it with a
    // generic "not selected" would delete the only useful part of the record.
  }

  return {
    candidates: candidates.sort((a, b) => a.strike - b.strike),
    selected: chosen,
    atmStrike: atm,
    strikeStep: step,
    unavailableReason: null,
  };
}

function buildCandidate(args: {
  role: StrikeRole;
  strike: number;
  side: 'CE' | 'PE';
  spot: number;
  entry: OptionChainEntry | undefined;
  policy: StrikeEvaluationPolicy;
}): StrikeCandidate {
  const { role, strike, side, spot, entry, policy } = args;

  const base: StrikeCandidate = {
    role,
    strike,
    optionType: side,
    premium: null,
    openInterest: null,
    volume: null,
    impliedVol: null,
    // Positive = in-the-money for this side. See the field's doc comment.
    moneyness: side === 'CE' ? spot - strike : strike - spot,
    tradable: false,
    selected: false,
    reason: '',
    checks: [],
  };

  if (!entry) {
    base.reason = `Not listed — the front-expiry chain carried no ${strike} row.`;
    base.checks = [
      { id: 'listed', label: 'Contract listed', passed: false, detail: `No ${strike} ${side} in the front-expiry chain.` },
    ];
    return base;
  }

  const premium = side === 'CE' ? entry.callLtp : entry.putLtp;
  const oi = side === 'CE' ? entry.callOI : entry.putOI;
  const volume = side === 'CE' ? entry.callVolume : entry.putVolume;
  const iv = side === 'CE' ? entry.callIV : entry.putIV;

  base.premium = premium != null && Number.isFinite(premium) ? premium : null;
  base.openInterest = Number.isFinite(oi) ? oi : null;
  base.volume = Number.isFinite(volume) ? volume : null;
  base.impliedVol = iv != null && Number.isFinite(iv) ? iv : null;

  const checks: CandidateCheck[] = [
    { id: 'listed', label: 'Contract listed', passed: true, detail: `${strike} ${side} present in the front-expiry chain.` },
  ];

  // An unpriced leg and a leg priced at zero are different facts and must not
  // collapse into one check: the first is a data gap, the second is a real
  // (and disqualifying) market price.
  if (base.premium == null) {
    checks.push({
      id: 'priced',
      label: 'Premium available',
      passed: false,
      detail: 'The chain published no last-traded premium for this leg.',
    });
  } else {
    checks.push({ id: 'priced', label: 'Premium available', passed: true, detail: `Last traded at ${base.premium.toFixed(2)}.` });
    const inBand = base.premium >= policy.minPremium && base.premium <= policy.maxPremium;
    checks.push({
      id: 'premium-band',
      label: 'Premium within band',
      passed: inBand,
      detail: inBand
        ? `${base.premium.toFixed(2)} is inside ${policy.minPremium}–${policy.maxPremium}.`
        : `${base.premium.toFixed(2)} is outside ${policy.minPremium}–${policy.maxPremium}.`,
    });
  }

  const oiOk = (base.openInterest ?? 0) >= policy.minOpenInterest;
  checks.push({
    id: 'open-interest',
    label: 'Open interest',
    passed: oiOk,
    detail: `${(base.openInterest ?? 0).toLocaleString()} against a ${policy.minOpenInterest.toLocaleString()} floor.`,
  });

  const volOk = (base.volume ?? 0) >= policy.minVolume;
  checks.push({
    id: 'volume',
    label: 'Traded volume',
    passed: volOk,
    detail: `${(base.volume ?? 0).toLocaleString()} against a ${policy.minVolume.toLocaleString()} floor.`,
  });

  base.checks = checks;
  base.tradable = checks.every((c) => c.passed);
  if (!base.tradable) {
    const failed = checks.filter((c) => !c.passed);
    base.reason = `Rejected — ${failed.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join('; ')}`;
  }
  return base;
}
