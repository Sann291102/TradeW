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
