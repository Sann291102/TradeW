import type { PayoffZone } from './payoff';
import type { ResolvedLeg } from './types';

/**
 * Turns payoff structure into descriptive English.
 *
 * Every string this module produces describes what a STRUCTURE does. None of
 * them tells a reader what to do. That is the whole point of the module
 * existing rather than the strings being inlined at their call sites — the
 * rule is easier to hold when the sentences live in one place.
 *
 *   "Sell the 24,050 call"                    ← an instruction; never
 *   "Risk begins above 24,050"                ← a property; correct
 *
 * See LEARNING-HUB.md §6 and the knowledge-base non-directive rule.
 */

/** "24,050" — Indian digit grouping, no currency symbol. */
function price(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/** Describes a band's extent: "below X", "above X", "X – Y". */
export function zoneRange(zone: PayoffZone): string {
  if (zone.from === null && zone.to === null) return 'at any price';
  if (zone.from === null) return `below ${price(zone.to!)}`;
  if (zone.to === null) return `above ${price(zone.from)}`;
  return `${price(zone.from)} – ${price(zone.to)}`;
}

/**
 * Describes what the structure does across a band, as price RISES through it.
 *
 * The slope matters as much as the sign. A bear call spread is still in profit
 * just above its short strike while that profit is falling away — describing
 * it as "gain increases" would be exactly backwards, which is what the first
 * version of this function did.
 */
export function zoneBehaviour(zone: PayoffZone): string {
  if (zone.capped) {
    return zone.kind === 'gain'
      ? 'Holds its maximum gain — it does not grow beyond this'
      : 'Loss has stopped growing — it stays flat across this band';
  }
  if (zone.kind === 'gain') {
    return zone.slope === 'rising' ? 'Gain builds as price rises through this band' : 'Gain shrinks as price rises through this band';
  }
  return zone.slope === 'falling' ? 'Loss deepens as price rises through this band' : 'Loss narrows as price rises through this band';
}

/**
 * The band a structure is built around — its outermost strikes.
 *
 * Phrased as where the setup is *centred*, not as something to act on.
 */
export function centredOn(legs: ResolvedLeg[]): string {
  const strikes = legs.map((l) => l.strikePrice);
  const low = Math.min(...strikes);
  const high = Math.max(...strikes);
  if (low === high) return `the ${price(low)} level`;
  return `the ${price(low)} – ${price(high)} band`;
}

/**
 * A leg's role, in structural terms.
 *
 * `long`/`short` are position states, not verbs aimed at the reader — this is
 * the standard vocabulary and it stays descriptive. "Buy"/"Sell" would not.
 */
export function legRole(leg: ResolvedLeg): string {
  const kind = leg.kind === 'CE' ? 'call' : leg.kind === 'PE' ? 'put' : leg.kind.toLowerCase();
  return `${leg.action === 'BUY' ? 'long' : 'short'} ${kind}`;
}

/** What a leg contributes to the structure, without instructing. */
export function legFunction(leg: ResolvedLeg): string {
  if (leg.kind !== 'CE' && leg.kind !== 'PE') return 'Defines the directional exposure';
  if (leg.action === 'SELL') return 'Brings in premium; risk begins beyond this strike';
  return 'Costs premium; caps the loss beyond this strike';
}

/** Short label for a chart marker — descriptive, never an action. */
export function legMarker(leg: ResolvedLeg): string {
  return `${leg.action === 'BUY' ? 'long' : 'short'} ${price(leg.strikePrice)}`;
}

export { price as formatPrice };
