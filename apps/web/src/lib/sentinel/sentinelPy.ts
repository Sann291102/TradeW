/**
 * Client for the Python Sentinel (`services/sentinel-py`) via services/api's
 * `/sentinel-py/*` routes.
 *
 * Lives here rather than at `lib/api/sentinelPy.ts` on purpose: `lib/api.ts`
 * already exists as a module, so a sibling `lib/api/` directory would make
 * `@/lib/api` ambiguous to resolve.
 *
 * Note there is no `confidence` field anywhere in this contract, and none is
 * synthesised. `strength` is the real ratio of mandatory conditions met to
 * mandatory conditions the user defined — a fact about their own rules rather
 * than a model's opinion. In-trade events carry strength 1.0 because they
 * already happened.
 */

import { api, ApiError } from '../api';

export type WatchState = 'IDLE' | 'FORMING' | 'CONFIRMED' | 'IN_TRADE' | 'EXITED';
export type Direction = 'LONG' | 'SHORT';

export type TimelineEventKind =
  | 'wait_and_watch'
  | 'confirmed'
  | 'rejected'
  | 'milestone_1R'
  | 'milestone_2R'
  | 'milestone_3R'
  | 'structure_break'
  | 'invalidation_reached'
  | 'projected_level_reached';

import type { WatchLeg } from './strategyApi';

export interface TimelineEvent {
  id: string;
  at: string;
  candleTime: string | null;
  kind: TimelineEventKind;
  state: WatchState;
  strength: number;
  conditionsMet: number | null;
  conditionsTotal: number | null;
  rMultiple: number | null;
  reason: string;
  notified: boolean;
  /** Start of this run of the same state, and how many sweeps it spans. The
   * sweep re-checks every 15s, so a state the watch is sitting in collapses
   * to one entry rather than one card per check. */
  firstAt: string;
  occurrences: number;
  /** Present on `rejected`: the conditions the setup had satisfied and then
   * gave back. */
  lostConditions?: string[];
}

export interface TimelineWatch {
  id: string;
  symbol: string;
  /** LEGACY mirror of the focused leg — read through `watchLegs`, not directly. */
  strike: string | null;
  optionType: 'CE' | 'PE' | null;
  expiry: string | null;
  /**
   * Both legs under observation, as `app/watch/timeline.py` reports them.
   * Optional because a legacy row carries neither; `watchLegs` reconstructs a
   * single-leg pair from the mirror columns in that case.
   */
  ce?: WatchLeg | null;
  pe?: WatchLeg | null;
  focusedSide?: 'CE' | 'PE' | null;
  state: WatchState;
  direction: Direction | null;
  strategyId: string;
  /**
   * The timeframe the SWEEP evaluates on, straight from the user's saved
   * strategy. `null` when their strategy named none (the engine then applies
   * its own 15m default, which is deliberately not duplicated here).
   *
   * This is what lets the chart be drawn on the same series the engine reads.
   * A 1m chart beside a 15m evaluation is two different instruments as far as
   * the user's eyes are concerned, and every disagreement between what they
   * see and what Sentinel says would be unexplainable.
   */
  timeframe: string | null;
  /**
   * The levels the USER declared when they recorded a position, `null` until
   * they do. Sentinel proposes none of them — reading them back is showing a
   * person their own contract, which is the one thing on this surface that is
   * allowed to state a price and still not be advice.
   *
   * Named for meaning, not order type: the engine's own columns are
   * `stopPrice`/`targetPrice` and the service corrects them at the boundary.
   */
  entryPrice: number | null;
  invalidationPrice: number | null;
  projectedPrice: number | null;
}

/**
 * What the engine MEASURED off the candles it read — as opposed to
 * `TimelineCondition`, which is which of the user's rules came out true.
 *
 * The sweep has always recorded these (services/sentinel-py's poller writes
 * them into every observation); nothing read them back until now, so the
 * workspace could say a condition was met without ever showing the geometry
 * behind it.
 *
 * Shapes inside `measurements` are the engine's, deliberately not re-typed
 * field by field here: they belong to the evaluator and re-declaring them in
 * the browser would create a second definition to keep in sync. The renderer
 * treats them as opaque labelled numbers.
 */
export interface TimelineReading {
  /** When the measured sweep ran. */
  at: string | null;
  /** The last candle the engine actually read. */
  candleTime: string | null;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  measurements: Record<string, unknown>;
  /**
   * Set when the MOST RECENT sweep could not read the market at all. The
   * measurements above are then the last thing that was true, not what is
   * true now — the distinction the UI must not blur.
   */
  unreadable: string | null;
}

export interface TimelineCondition {
  id: string;
  name: string;
  mandatory: boolean;
  met: boolean;
  detail: string;
}

export interface Timeline {
  watch: TimelineWatch;
  /** Per-condition state as of the latest readable sweep. The focus panel
   * renders this; the feed deliberately does not repeat it. */
  conditions: TimelineCondition[];
  /** `null` until the watch has been swept at least once. */
  reading: TimelineReading | null;
  events: TimelineEvent[];
}

export interface StrategyPerformance {
  strategyId: string;
  funnel: {
    watches: number;
    interactions: number;
    confirmations: number;
    entries: number;
    outcomes: number;
    rejections: number;
  };
  outcomes: { reachedProjected: number; reachedInvalidation: number; stillOpen: number };
  r: {
    completed: number;
    expectancy: number | null;
    best: number | null;
    worst: number | null;
    avgMfe: number | null;
    avgMae: number | null;
  };
  sufficient: boolean;
  note: string;
}

export function fetchStrategyPerformance(strategyId: string): Promise<StrategyPerformance> {
  return api(
    `/sentinel-py/strategies/${encodeURIComponent(strategyId)}/performance`,
  ) as Promise<StrategyPerformance>;
}

export interface WatchSummary {
  id: string;
  symbol: string;
  strike: string | null;
  optionType: 'CE' | 'PE' | null;
  expiry: string | null;
  state: WatchState;
  direction: Direction | null;
  entryPrice: number | null;
  strategyId: string;
}

export function listWatches(): Promise<WatchSummary[]> {
  return api('/sentinel-py/watch') as Promise<WatchSummary[]>;
}

export function fetchTimeline(watchId: string, limit = 100): Promise<Timeline> {
  return api(`/sentinel-py/watch/${encodeURIComponent(watchId)}/timeline?limit=${limit}`) as Promise<Timeline>;
}

export { ApiError };
