/**
 * The ONE typed model of the strategy contract, and the only place the
 * `/strategies/:id/contract` payload is interpreted.
 *
 * Every strategy component reads this model and nothing else. That rule is
 * the whole architecture of the workspace: with six components each parsing
 * the API for themselves, they would drift, and the first strategy whose
 * shape differed slightly would get a special case — then another, until the
 * generic contract exists on paper only.
 *
 * ## No strategy-specific knowledge lives in the frontend
 *
 * There is deliberately no `if (template.id === 'ema7_bullish_reclaim')`
 * anywhere in this file or in any component that uses it, and a test asserts
 * two very different strategies render through identical components. Anything
 * that varies per strategy — condition names, observed context, which
 * breakdowns exist — arrives as DATA from the backend.
 *
 * ## Nothing here ranks or recommends
 *
 * The catalogue is a menu the user adopts from. Performance describes the
 * user's own history. No component computes a score, sorts by quality, or
 * turns any of this into an instruction to trade.
 */

import { api, ApiError } from '../api';
import type { Direction, TimelineEvent, TimelineWatch, WatchState } from './sentinelPy';

export interface TemplateSummary {
  id: string | null;
  name: string;
  summary: string;
  direction?: 'both' | 'long_only';
  available: boolean;
  requires?: string[];
  missing?: string[];
  /** Why an unavailable template cannot be adopted, in the backend's own
   * words. Never paraphrased here: some templates wait on a primitive and
   * some on an entire subsystem, and flattening that distinction would make
   * a pipeline look like an afternoon's work. */
  unavailableReason?: string;
  rules?: Record<string, unknown>;
}

export type ParameterType = 'choice' | 'toggle' | 'readonly';

export interface ConfigParameter {
  key: string;
  label: string;
  type: ParameterType;
  value: string | boolean;
  options?: string[];
  /** Mandatory rules render as fixed. Switching one off would leave a
   * strategy sharing its name with the adopted one and none of its meaning. */
  locked?: boolean;
  group?: 'mandatory' | 'optional';
}

export interface ContractCondition {
  id: string;
  name: string;
  mandatory: boolean;
  met: boolean;
  detail: string;
}

export interface ContractWatch {
  id: string;
  direction?: Direction | null;
  symbol: string | null;
  strike: string | null;
  optionType: 'CE' | 'PE' | null;
  expiry: string | null;
  state: WatchState | null;
  status: string | null;
  conditions: ContractCondition[];
  met: number;
  total: number;
}

export interface ObservedContext {
  at: string;
  candleTime: string | null;
  state: string | null;
  /** The evaluator's own measurements, passed through untouched. The panel
   * displays whatever keys are present rather than asking for ones it knows,
   * which is what lets a new evaluator appear without a frontend change. */
  context: Record<string, unknown>;
}

export interface SegmentBucket {
  label: string;
  observations: number;
  confirmations: number;
}

export interface Segment {
  id: string;
  label: string;
  buckets: SegmentBucket[];
  samples: number;
}

export interface Performance {
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

export interface StrategyContract {
  id: string;
  name: string;
  status: string;
  template: TemplateSummary;
  configuration: { parameters: ConfigParameter[] };
  watches: ContractWatch[];
  focusedWatchId: string | null;
  currentState: WatchState | null;
  conditions: ContractCondition[];
  latestObservation: ObservedContext | null;
  lifecycle: TimelineEvent[];
  performance: Performance;
  /** Which breakdowns this user's history can support. Empty until watches
   * have actually produced observations. */
  availableAnalytics: string[];
  segments: Segment[];
}

export function fetchStrategyContract(
  strategyId: string,
  watchId?: string,
): Promise<StrategyContract> {
  const suffix = watchId ? `?watchId=${encodeURIComponent(watchId)}` : '';
  return api(
    `/sentinel-py/strategies/${encodeURIComponent(strategyId)}/contract${suffix}`,
  ) as Promise<StrategyContract>;
}

export function listTemplates(): Promise<TemplateSummary[]> {
  return api('/sentinel-py/strategies/templates') as Promise<TemplateSummary[]>;
}

export function adoptTemplate(templateId: string, name?: string): Promise<{ id: string }> {
  const suffix = name ? `?name=${encodeURIComponent(name)}` : '';
  return api(
    `/sentinel-py/strategies/templates/${encodeURIComponent(templateId)}/adopt${suffix}`,
    { method: 'POST' },
  ) as Promise<{ id: string }>;
}

/**
 * Split the catalogue for display. Not a ranking: available and unavailable
 * are a fact about the watch engine, and within each group the backend's own
 * order is preserved rather than sorted by anything that could read as
 * "better".
 */
export function splitCatalogue(templates: TemplateSummary[]): {
  available: TemplateSummary[];
  unavailable: TemplateSummary[];
} {
  return {
    available: templates.filter((t) => t.available),
    unavailable: templates.filter((t) => !t.available),
  };
}

/**
 * Adapt a contract watch to the shape the existing event card renders.
 *
 * The card predates the contract and takes a `TimelineWatch`. Converting here
 * rather than in the component keeps the rule intact: components consume the
 * contract model, and exactly one module knows how the two shapes relate.
 */
export function toTimelineWatch(
  watch: ContractWatch,
  strategyId: string,
): TimelineWatch {
  return {
    id: watch.id,
    symbol: watch.symbol ?? '',
    strike: watch.strike,
    optionType: watch.optionType,
    expiry: watch.expiry,
    state: (watch.state ?? 'IDLE') as WatchState,
    direction: watch.direction ?? null,
    strategyId,
  };
}

/** Segments worth rendering. A dimension with no samples is not shown at all
 * — an empty three-bar chart reads as three findings. */
export function renderableSegments(contract: StrategyContract): Segment[] {
  return contract.segments.filter((segment) => segment.samples > 0);
}

/** Flatten observed context into label/value rows for display.
 *
 * Generic on purpose: it walks whatever the evaluator recorded rather than
 * naming pullbacks, VWAP deviations or liquidity stages. Internal bookkeeping
 * the user has no use for is dropped, and everything else is shown.
 */
const HIDDEN_CONTEXT_KEYS = new Set([
  'mandatoryMet',
  'mandatoryTotal',
  'notified',
  'reason',
  'skipped',
  'detail',
]);

export function contextRows(observation: ObservedContext | null): { label: string; value: string }[] {
  if (!observation) return [];
  const rows: { label: string; value: string }[] = [];

  const humanise = (key: string) =>
    key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

  for (const [key, value] of Object.entries(observation.context)) {
    if (HIDDEN_CONTEXT_KEYS.has(key) || value == null) continue;
    if (typeof value === 'object') {
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue == null || typeof innerValue === 'object') continue;
        rows.push({ label: `${humanise(key)} · ${humanise(innerKey)}`, value: String(innerValue) });
      }
      continue;
    }
    rows.push({ label: humanise(key), value: String(value) });
  }
  return rows;
}

export { ApiError };
