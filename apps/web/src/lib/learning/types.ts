/**
 * Learning Hub content model. The source of truth is the markdown frontmatter
 * in `docs/learning/` — see that folder's README for the authoring contract.
 * These types mirror it exactly; when the contract changes, both move together.
 */

export type LegAction = 'BUY' | 'SELL';
export type LegKind = 'CE' | 'PE' | 'FUT' | 'EQ';
export type LegExpiry = 'near' | 'next' | 'far';
export type NetFlow = 'debit' | 'credit' | 'zero';
export type Tier = 'beginner' | 'intermediate' | 'advanced';

/**
 * A strategy leg as authored — strike is RELATIVE (`ATM`, `ATM+2`, `ATM-3`),
 * never absolute. `strikeOffset` is that offset already parsed into a signed
 * number of strike steps, so resolving against a live underlying is
 * `atm + strikeOffset * strikeStep` and nothing else.
 *
 * Relative strikes are what let one lesson apply to NIFTY at 24,800 and to a
 * stock at 430 without editing the lesson.
 */
export interface StrategyLeg {
  action: LegAction;
  kind: LegKind;
  /** Verbatim authored value, e.g. "ATM+2" — kept for display. */
  strike: string;
  /** Parsed offset in strike steps. "ATM" -> 0, "ATM+2" -> 2, "ATM-3" -> -3. */
  strikeOffset: number;
  ratio: number;
  expiry: LegExpiry;
}

/** A leg with its strike resolved against a real underlying price. */
export interface ResolvedLeg extends StrategyLeg {
  /** Absolute strike in rupees. */
  strikePrice: number;
  /** Estimated premium per unit, from Black-Scholes. Never a live quote. */
  premium: number;
}

export interface Strategy {
  id: string;
  name: string;
  category: string;
  tier: Tier;
  summary: string;
  /** Backing knowledge-base concept id, if the lesson declares one. */
  concept?: string;
  legs: StrategyLeg[];
  net: NetFlow;
  outlook: string;
  maxProfit: string;
  maxLoss: string;
  breakeven: string;
  greeks: Record<string, string>;
  /** One sentence shown under the chart after Apply. */
  chartNote: string;
  /** Repo-relative path of the lesson, for provenance and deep links. */
  path: string;
}

/** A non-strategy lesson — everything without `legs` frontmatter. */
export interface Lesson {
  id: string;
  name: string;
  category: string;
  tier: Tier;
  summary: string;
  concept?: string;
  path: string;
}
