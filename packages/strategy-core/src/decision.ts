/**
 * The candidate decision record — what the bot saw, what it proposed, and why
 * it did or did not act.
 *
 * ## Why the record is produced for refusals too
 *
 * A journal of trades explains the trades and nothing else. The question that
 * actually improves a strategy is "what did you nearly take, and why didn't
 * you?" — and that information exists for a few seconds inside the scan and is
 * then gone forever unless it is written down.
 *
 * So a `TradeCandidate` is produced for every MEANINGFUL setup, accepted or
 * refused, and refusal carries a closed-set reason plus the detail that names
 * the numbers. `agent-exhaustion-reversal rejected: risk 12.4 is 0.31 ATR,
 * under the 0.4 floor` is an analysable fact. "No trade" is not.
 *
 * ## Why it is not produced for every tick
 *
 * The previous evaluation ledger wrote one row per profile per 30 seconds
 * whatever happened, and by the time anyone read it, 5,202 of its 5,223 rows
 * said `MARKET_CLOSED`. A table that is 98% noise is not a record, and the
 * signal in it cannot be found. `isMeaningfulCandidate` below is the filter:
 * a setup is worth a row when it validated, or when it came within one rule of
 * validating. Everything else is the market simply not offering anything, and
 * that is what an empty result set already says.
 *
 * ## Decision-time state is immutable
 *
 * Everything on this record describes the moment of the decision. When the
 * trade later closes, the outcome is written to a SEPARATE record that
 * references this one. Nothing here is ever rewritten — "was the original
 * reasoning correct?" is only answerable if the original reasoning still says
 * what it said before the answer was known.
 */

import type { LevelPlan, LevelRefusalReason, TradeDirection } from './levels';
import { LEVEL_REFUSAL_LABELS } from './levels';
import type { MarketSnapshot } from './snapshot';
import type { SetupArchetype, SetupBias, SetupDetection } from './setups';

/**
 * Why a meaningful candidate did not become a trade.
 *
 * A closed set, extending the level layer's own reasons with the ones that
 * arise before levels are attempted. Closed rather than free text for the same
 * reason `IMPROVEMENT_KINDS` is closed: these are grouped and counted by the
 * feedback layer, and a free-text reason cannot be counted — "insufficient
 * R:R" and "insufficient risk-reward" would become two findings about one
 * cause.
 *
 * Venue-specific refusals (an option chain that cannot express 1:3 in premium,
 * a lot that exceeds the allocation) are NOT here: they belong to the
 * execution adapter, which owns the venue, and they arrive through
 * `venue-refusal` carrying the adapter's own check id.
 */
export type RejectionReason =
  | LevelRefusalReason
  | 'setup-not-validated'
  | 'setup-invalidated'
  | 'regime-unsuitable'
  | 'outside-ideal-session'
  | 'insufficient-history'
  | 'direction-not-supported'
  | 'venue-refusal';

export const REJECTION_LABELS: Record<RejectionReason, string> = {
  ...LEVEL_REFUSAL_LABELS,
  'setup-not-validated': 'Every rule confirmed',
  'setup-invalidated': 'No invalidation rule fired',
  'regime-unsuitable': 'Setup applies in the current regime',
  'outside-ideal-session': 'Inside the setup’s session window',
  'insufficient-history': 'Enough bars to decide on',
  'direction-not-supported': 'Setup can trade the side its bias resolved to',
  'venue-refusal': 'The venue can express this trade',
};

/**
 * The decision-time market state, flattened.
 *
 * A deliberate projection of `MarketSnapshot` rather than the snapshot itself:
 * the snapshot carries hundreds of candles and a full option chain, and
 * storing that per candidate would make the journal enormous while burying the
 * handful of numbers anyone actually reads back. These are the features the
 * rules above decided on.
 */
export interface DecisionFeatures {
  lastPrice: number;
  atr: number | null;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  macdHistogram: number | null;
  volumeVsAvg: number | null;
  realizedVolPct: number | null;
  support: number | null;
  resistance: number | null;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  marketProfile: string | null;
  structureState: string | null;
  trendDirection: string | null;
  barsAnalysed: number;
  latestBarAt: string | null;
}

export interface TradeCandidate {
  /** Which market and instrument this is about. */
  market: string;
  symbol: string;
  timeframe: string;
  /** When the decision was taken (wall clock of the scan). */
  decidedAt: Date;
  /** The bar the decision was made ON — market-event time, not poll time. */
  signalBarAt: Date | null;

  setupId: string;
  setupName: string;
  setupVersion: string;
  archetype: SetupArchetype;

  bias: SetupBias;
  direction: TradeDirection | null;
  /** 0..100 — share of the setup's rules that confirmed. */
  quality: number;

  confirmed: { ruleId: string; note: string }[];
  unmet: { ruleId: string; note: string }[];
  invalidated: { ruleId: string; note: string }[];

  regime: string | null;
  features: DecisionFeatures;

  /** The proposed levels. Present whenever derivation succeeded. */
  plan: LevelPlan | null;

  accepted: boolean;
  rejectionReason: RejectionReason | null;
  rejectionDetail: string | null;

  /** The prose answer to "why did the bot take (or refuse) this trade?". */
  explanation: string;
}

/** Project a snapshot down to the features worth keeping. */
export function extractFeatures(snapshot: MarketSnapshot, atrValue: number | null): DecisionFeatures {
  const bars = snapshot.candles;
  const newest = bars[bars.length - 1] ?? null;
  return {
    lastPrice: snapshot.lastPrice,
    atr: atrValue,
    rsi14: snapshot.rsi14,
    ema20: snapshot.ema20,
    ema50: snapshot.ema50,
    vwap: snapshot.vwap,
    macdHistogram: snapshot.macdHistogram,
    volumeVsAvg: snapshot.volumeVsAvg,
    realizedVolPct: snapshot.realizedVolPct,
    support: snapshot.support,
    resistance: snapshot.resistance,
    openingRangeHigh: snapshot.openingRange?.high ?? null,
    openingRangeLow: snapshot.openingRange?.low ?? null,
    marketProfile: snapshot.marketProfile?.type ?? null,
    structureState: null,
    trendDirection: snapshot.trendAnalysis?.direction ?? null,
    barsAnalysed: bars.length,
    latestBarAt: newest ? new Date(newest.timestamp).toISOString() : null,
  };
}

/**
 * Is this detection worth a journal row?
 *
 * Validated setups always are. A near-miss — everything confirmed but one rule,
 * with nothing invalidating — is the most informative row in the table: it is
 * the setup the market almost offered, and a season of them is what tells you
 * whether a rule is doing work or just blocking trades.
 *
 * Everything below that is the market not offering the setup, which needs no
 * row. This is the filter that keeps the journal a record rather than a log.
 */
export function isMeaningfulCandidate(detection: SetupDetection): boolean {
  if (detection.validated) return true;
  return detection.unmet.length <= 1 && detection.invalidated.length === 0;
}

/**
 * The human-readable "why", built from the notes the rules themselves emitted.
 *
 * Every clause traces to a `RuleOutcome.note` or a `LevelPlan.rationale` line,
 * both of which carry real numbers computed at decision time. Nothing here is
 * a template filled in afterwards from the outcome — which is the difference
 * between a journal that explains a decision and one that rationalises it.
 */
export function buildExplanation(args: {
  setupName: string;
  direction: TradeDirection | null;
  symbol: string;
  confirmed: { ruleId: string; note: string }[];
  invalidated: { ruleId: string; note: string }[];
  unmet: { ruleId: string; note: string }[];
  plan: LevelPlan | null;
  accepted: boolean;
  rejectionReason: RejectionReason | null;
  rejectionDetail: string | null;
}): string {
  const {
    setupName, direction, symbol, confirmed, invalidated, unmet,
    plan, accepted, rejectionReason, rejectionDetail,
  } = args;

  const parts: string[] = [];

  if (accepted && plan && direction) {
    parts.push(
      `Entered ${direction} on ${symbol} because ${setupName} confirmed on every rule: ` +
        confirmed.map((c) => c.note).join('; ') + '.',
    );
    parts.push(
      `Invalidation is structural — ${plan.anchor.note}, so the stop sits at ${plan.stop} ` +
        `(${plan.riskAtr} ATR of risk, ${plan.riskPerUnit} points).`,
    );
    parts.push(
      `Target ${plan.target} is ${plan.plannedRR}R at ${plan.rewardPerUnit} points, ` +
        `${plan.targetAtr} ATR away — a move this instrument is currently making.`,
    );
    return parts.join(' ');
  }

  const opener = direction
    ? `Did not take a ${direction} on ${symbol} from ${setupName}`
    : `Did not act on ${setupName} for ${symbol}`;

  if (rejectionReason === 'setup-not-validated' && unmet.length > 0) {
    parts.push(
      `${opener}: ${confirmed.length} of ${confirmed.length + unmet.length} rules confirmed, but ` +
        unmet.map((u) => u.note).join('; ') + '.',
    );
  } else if (rejectionReason === 'setup-invalidated' && invalidated.length > 0) {
    parts.push(`${opener}: the setup was invalidated — ` + invalidated.map((i) => i.note).join('; ') + '.');
  } else {
    parts.push(`${opener}: ${rejectionDetail ?? 'no reason recorded'}`);
  }

  // A refused candidate that HAD confirmations is more useful with them kept:
  // it is the difference between "nothing happened" and "this nearly worked".
  if (confirmed.length > 0 && rejectionReason !== 'setup-not-validated') {
    parts.push(`What did confirm: ` + confirmed.map((c) => c.note).join('; ') + '.');
  }

  if (plan) {
    parts.push(
      `The levels it would have used: entry ${plan.entry}, stop ${plan.stop}, target ${plan.target}.`,
    );
  }

  return parts.join(' ');
}
