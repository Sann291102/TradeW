import { blackScholesPrice } from '../black-scholes';
import { mockIvPct } from '../mock/optionChain';
import type { ResolvedLeg, Strategy, StrategyLeg } from './types';

/**
 * Resolves a strategy's relative strikes against a live underlying and builds
 * its expiry payoff curve.
 *
 * Premiums are ESTIMATED via Black-Scholes — there is no live per-contract
 * premium feed in this app. Every surface that renders these numbers says so.
 * The shape of the payoff (breakevens, max profit, max loss) is structurally
 * correct; the rupee magnitudes are indicative.
 */

/**
 * A single flat volatility is used for every leg, deliberately.
 *
 * The Option Chain's `mockIvPct` smile raises IV by |steps|^1.5, which is
 * steep enough that a far-OTM option can price ABOVE a nearer one. That breaks
 * monotonicity of option price in strike, and a spread built on it inverts —
 * a bull put spread priced with that smile comes out as a net DEBIT, which is
 * the opposite of what the structure is. Constant-volatility Black-Scholes is
 * arbitrage-free by construction, so credit structures always price as credits
 * and debit structures as debits.
 *
 * The cost is that these curves do not show skew. That is the right trade for
 * a diagram whose job is to teach a structure's shape: skew is taught in the
 * lesson prose (`volatility/smile-and-skew.md`), not in the payoff.
 */
const FLAT_IV_PCT = mockIvPct(0);

/** Rounds spot to the nearest tradable strike. */
export function atmStrike(spot: number, strikeStep: number): number {
  return Math.round(spot / strikeStep) * strikeStep;
}

export function resolveLegs(
  legs: StrategyLeg[],
  spot: number,
  strikeStep: number,
  yearsToExpiry: number,
  ivPct: number = FLAT_IV_PCT,
): ResolvedLeg[] {
  const atm = atmStrike(spot, strikeStep);

  return legs.map((leg) => {
    const strikePrice = atm + leg.strikeOffset * strikeStep;
    // FUT/EQ legs have no premium — they are entered at spot, and their P&L is
    // handled by `legPayoff` rather than by an option price.
    const premium =
      leg.kind === 'CE' || leg.kind === 'PE'
        ? blackScholesPrice(spot, strikePrice, yearsToExpiry, ivPct, leg.kind === 'CE' ? 'call' : 'put')
        : 0;
    return { ...leg, strikePrice, premium };
  });
}

/** Net cash at entry, per unit: positive is a credit received, negative a debit paid. */
export function netPremium(legs: ResolvedLeg[]): number {
  return legs.reduce((sum, leg) => sum + (leg.action === 'SELL' ? 1 : -1) * leg.premium * leg.ratio, 0);
}

/** One leg's profit or loss per unit at an expiry price. */
function legPayoff(leg: ResolvedLeg, price: number, spot: number): number {
  const direction = leg.action === 'BUY' ? 1 : -1;

  if (leg.kind === 'FUT' || leg.kind === 'EQ') return direction * (price - spot) * leg.ratio;

  const intrinsic = leg.kind === 'CE' ? Math.max(0, price - leg.strikePrice) : Math.max(0, leg.strikePrice - price);
  return direction * (intrinsic - leg.premium) * leg.ratio;
}

/** The whole position's profit or loss per unit at an expiry price. */
export function payoffAt(legs: ResolvedLeg[], price: number, spot: number): number {
  return legs.reduce((sum, leg) => sum + legPayoff(leg, price, spot), 0);
}

export interface PayoffPoint {
  price: number;
  pnl: number;
}

/**
 * A contiguous price band over which the structure behaves one way.
 *
 * Zones are how this app describes a strategy WITHOUT issuing instructions.
 * "Full gain is retained below 24,050" states what the structure does; "sell
 * the 24,050 call" tells someone what to do. Only the first belongs in a
 * teaching surface — see LEARNING-HUB.md §6 and the knowledge-base
 * non-directive rule.
 */
export interface PayoffZone {
  kind: 'gain' | 'loss';
  /** Flat across the band — the gain or loss does not grow further here. */
  capped: boolean;
  /**
   * Which way P&L moves as price RISES through the band.
   *
   * Needed because "gain" alone does not say whether the gain is growing or
   * shrinking. In a bear call spread's band just above the short strike the
   * position is still profitable while its profit falls toward zero — calling
   * that "gain increases" is precisely backwards.
   */
  slope: 'rising' | 'falling' | 'flat';
  /** null means the band continues past the sampled window. */
  from: number | null;
  to: number | null;
}

export interface PayoffProfile {
  points: PayoffPoint[];
  breakevens: number[];
  /** null when the curve is still rising at the edge of the sampled range. */
  maxProfit: number | null;
  /** null when the curve is still falling at the edge of the sampled range. */
  maxLoss: number | null;
  netPremium: number;
  legs: ResolvedLeg[];
  atm: number;
}

/**
 * Samples the expiry payoff across a price range centred on spot.
 *
 * The range spans `spread` either side of spot — wide enough that every strike
 * plus a margin is inside it, so the flat outer regions of a condor or spread
 * are visible rather than cropped at the last strike.
 */
export function buildPayoffProfile(
  strategy: Strategy,
  spot: number,
  strikeStep: number,
  yearsToExpiry: number,
  samples = 161,
): PayoffProfile {
  const legs = resolveLegs(strategy.legs, spot, strikeStep, yearsToExpiry);
  const strikes = legs.map((l) => l.strikePrice);

  // The window has to reach past the BREAKEVENS, not merely past the strikes.
  // A breakeven sits at most one gross-premium away from the outermost strike
  // (a long straddle breaks even at strike ± total premium), so the premium
  // has to be part of the span. Sizing on strike distance alone silently
  // cropped the breakevens of every straddle, strangle and naked leg.
  const widestStrike = Math.max(...strikes.map((s) => Math.abs(s - spot)), strikeStep * 2);
  const grossPremium = legs.reduce((sum, l) => sum + Math.abs(l.premium) * l.ratio, 0);
  const spread = widestStrike + grossPremium + strikeStep * 2;
  const low = Math.max(0, spot - spread);
  const high = spot + spread;
  const step = (high - low) / (samples - 1);

  const points: PayoffPoint[] = [];
  for (let i = 0; i < samples; i += 1) {
    const price = low + i * step;
    points.push({ price, pnl: payoffAt(legs, price, spot) });
  }

  // Breakevens by sign change, refined by linear interpolation. The payoff is
  // piecewise-linear in price, so interpolation between two adjacent samples is
  // exact unless a strike falls between them — close enough at this sampling
  // density, and always within one step of the true crossing.
  const breakevens: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a.pnl === 0) breakevens.push(a.price);
    else if ((a.pnl < 0 && b.pnl > 0) || (a.pnl > 0 && b.pnl < 0)) {
      breakevens.push(a.price + ((0 - a.pnl) / (b.pnl - a.pnl)) * (b.price - a.price));
    }
  }

  // A payoff still sloping at the sampled edge is unbounded in that direction —
  // report null rather than the edge sample, which would present the window's
  // boundary as if it were the strategy's real limit.
  const pnls = points.map((p) => p.pnl);
  const edge = Math.max(step * 0.01, 1e-6);
  const risingAtTop = pnls[pnls.length - 1] - pnls[pnls.length - 2] > edge;
  const fallingAtTop = pnls[pnls.length - 2] - pnls[pnls.length - 1] > edge;
  const risingAtBottom = pnls[0] - pnls[1] > edge;
  const fallingAtBottom = pnls[1] - pnls[0] > edge;

  return {
    points,
    breakevens,
    maxProfit: risingAtTop || risingAtBottom ? null : Math.max(...pnls),
    maxLoss: fallingAtTop || fallingAtBottom ? null : Math.min(...pnls),
    netPremium: netPremium(legs),
    legs,
    atm: atmStrike(spot, strikeStep),
  };
}

/**
 * Splits a payoff into the price bands where it gains and where it loses,
 * marking which of those bands are capped.
 *
 * Boundaries are the STRIKES as well as the breakevens. An expiry payoff is
 * piecewise-linear with kinks only at strikes, so a band bounded by both is
 * guaranteed to have a single constant slope — which is what makes "is this
 * band flat?" a well-defined question.
 *
 * Using breakevens alone (the first attempt) let one band straddle a strike,
 * covering a flat region and a sloping one at once. The flatness test then
 * failed for the whole band, and a bull call spread reported its capped gain
 * as continuing to infinity — the payoff diagram said one thing and the words
 * said the opposite.
 */
export function payoffZones(profile: PayoffProfile): PayoffZone[] {
  const { points, breakevens, legs } = profile;
  if (!points.length) return [];

  const first = points[0].price;
  const last = points[points.length - 1].price;

  const pnls = points.map((p) => p.pnl);
  const span = Math.max(...pnls) - Math.min(...pnls);
  // "Flat" is relative to the payoff's own scale — an absolute epsilon would
  // call every band flat on a small structure and none flat on a large one.
  const flatTolerance = Math.max(span * 0.01, 1e-6);

  const interior = [...legs.map((l) => l.strikePrice), ...breakevens]
    .filter((price) => price > first && price < last)
    .sort((a, b) => a - b)
    .filter((price, i, all) => i === 0 || price - all[i - 1] > 1e-9);

  const edges = [first, ...interior, last];
  const raw: PayoffZone[] = [];

  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const inside = points.filter((p) => p.price > lo && p.price < hi);
    if (!inside.length) continue;

    const values = inside.map((p) => p.pnl);
    const capped = Math.max(...values) - Math.min(...values) <= flatTolerance;
    const change = values[values.length - 1] - values[0];

    raw.push({
      kind: values[Math.floor(values.length / 2)] >= 0 ? 'gain' : 'loss',
      capped,
      slope: capped ? 'flat' : change > 0 ? 'rising' : 'falling',
      // A band touching the sampled edge continues beyond it.
      from: i === 0 ? null : lo,
      to: i === edges.length - 2 ? null : hi,
    });
  }

  // Adjacent bands that behave identically are one band as far as a reader is
  // concerned — splitting them at a strike the payoff does not actually bend
  // at would be noise.
  const zones: PayoffZone[] = [];
  for (const zone of raw) {
    const previous = zones[zones.length - 1];
    if (previous && previous.kind === zone.kind && previous.capped === zone.capped && previous.slope === zone.slope) previous.to = zone.to;
    else zones.push({ ...zone });
  }

  return zones;
}
