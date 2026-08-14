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
  | 'milestone_1R'
  | 'milestone_2R'
  | 'milestone_3R'
  | 'structure_break'
  | 'invalidation_reached'
  | 'projected_level_reached';

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
}

export interface TimelineWatch {
  id: string;
  symbol: string;
  strike: string | null;
  optionType: 'CE' | 'PE' | null;
  expiry: string | null;
  state: WatchState;
  direction: Direction | null;
  strategyId: string;
}

export interface Timeline {
  watch: TimelineWatch;
  events: TimelineEvent[];
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
