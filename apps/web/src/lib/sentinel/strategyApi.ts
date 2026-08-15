import { api } from '@/lib/api';

/**
 * Browser client for the Python Sentinel (services/sentinel-py), reached
 * through the `/sentinel-py` proxy in services/api.
 *
 * The types below mirror `app/strategy/schemas.py` and the row shape
 * `app/watch/store.py` returns. They are hand-written rather than generated
 * because the proxy is the contract boundary — if the Python schema changes,
 * this file is the one place the UI has to follow it.
 *
 * ## The user id is not ours to send
 *
 * sentinel-py scopes every query by `userId`, and `SentinelPyService` fills
 * that from the authenticated JWT, never from the request body. So nothing
 * here takes a user id, and nothing here should start to: a `userId` field
 * added to any of these payloads would be silently ignored at best, and at
 * worst would read as an attempt to act as someone else.
 */

export interface StrategyRule {
  id: string;
  name: string;
  condition: string;
  mandatory: boolean;
  description: string;
}

export interface StrategyEntry {
  long?: string | null;
  short?: string | null;
}

export interface StrategyRiskManagement {
  stopLoss?: string | null;
  targets: string[];
}

/** The structured rule set the deterministic parser produces from free text. */
export interface ParsedStrategy {
  timeframe: string | null;
  levels: string[];
  rules: StrategyRule[];
  entry: StrategyEntry;
  riskManagement: StrategyRiskManagement;
}

export interface ParseResponse {
  parsed: ParsedStrategy;
  /** Non-fatal: what the parser could NOT find. Shown, never hidden. */
  warnings: string[];
}

export type StrategyStatus = 'active' | 'paused' | 'archived';

export interface UserStrategy {
  id: string;
  userId: string;
  name: string;
  rules: ParsedStrategy;
  rawInput: string | null;
  inputType: string;
  status: StrategyStatus;
  createdAt: string;
  updatedAt: string;
}

export type WatchState = 'IDLE' | 'FORMING' | 'CONFIRMED' | 'IN_TRADE' | 'EXITED';

export type OptionType = 'CE' | 'PE';

export type PositionDirection = 'LONG' | 'SHORT';

export interface WatchSession {
  id: string;
  userId: string;
  strategyId: string;
  symbol: string;
  strike: string | null;
  optionType: OptionType | null;
  expiry: string | null;
  state: WatchState;
  /**
   * The user's own declared numbers, present only once they have marked a
   * position taken. `stopPrice` is the invalidation level they set and
   * `targetPrice` the level they projected — named after the database columns,
   * surfaced in the UI with the vocabulary the rest of Sentinel uses.
   */
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  direction: PositionDirection | null;
  reachedMilestones: string[];
  lastNotifiedAt: string | null;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWatchInput {
  strategyId: string;
  symbol: string;
  strike?: string | null;
  optionType?: OptionType | null;
  expiry?: string | null;
}

export interface OpenPositionInput {
  entryPrice: number;
  /** The price at which the user considers the idea wrong. */
  invalidationPrice: number;
  projectedPrice?: number | null;
  direction: PositionDirection;
}

// --- strategies -------------------------------------------------------------

/** Preview only — nothing is saved. The confirmation step. */
export function parseStrategyText(text: string): Promise<ParseResponse> {
  return api('/sentinel-py/strategies/parse', { method: 'POST', body: JSON.stringify({ text }) });
}

export function createStrategy(input: {
  name: string;
  rawInput: string;
  rules: ParsedStrategy;
}): Promise<UserStrategy> {
  return api('/sentinel-py/strategies', {
    method: 'POST',
    body: JSON.stringify({ ...input, inputType: 'text' }),
  });
}

export function listStrategies(): Promise<UserStrategy[]> {
  return api('/sentinel-py/strategies');
}

export function updateStrategy(
  id: string,
  patch: { name?: string; status?: StrategyStatus; rules?: ParsedStrategy },
): Promise<UserStrategy> {
  return api(`/sentinel-py/strategies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Soft delete — the strategy is archived, never destroyed. */
export function archiveStrategy(id: string): Promise<UserStrategy> {
  return api(`/sentinel-py/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- watches ----------------------------------------------------------------

export function createWatch(input: CreateWatchInput): Promise<WatchSession> {
  return api('/sentinel-py/watch', { method: 'POST', body: JSON.stringify(input) });
}

export function listWatches(): Promise<WatchSession[]> {
  return api('/sentinel-py/watch');
}

/** "I have taken this position." Every number in `input` is the user's own. */
export function openPosition(watchId: string, input: OpenPositionInput): Promise<WatchSession> {
  return api(`/sentinel-py/watch/${encodeURIComponent(watchId)}/position`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** "I have closed this position." */
export function closePosition(watchId: string): Promise<WatchSession> {
  return api(`/sentinel-py/watch/${encodeURIComponent(watchId)}/position`, { method: 'DELETE' });
}
