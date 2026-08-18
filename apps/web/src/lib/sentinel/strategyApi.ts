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

/**
 * One listed option contract on a watch, carried by IDENTITY rather than by
 * strike number.
 *
 * Mirrors `OptionInstrument` in `watchState.ts` and the columns
 * `app/watch/store.py` writes. The securityId is the field that makes this an
 * instrument instead of a description: it is what the Dhan feed subscribes,
 * what the historical API is addressed by, and what proves the CE chart and the
 * CE leg of the watch are the same contract rather than two independent
 * re-derivations that happen to agree today.
 */
export interface WatchLeg {
  strike: number;
  optionType: OptionType;
  securityId: string;
  exchangeSegment: string;
  tradingSymbol: string;
  dhanInstrument: string;
  lotSize: number | null;
  tickSize: number | null;
}

export type WatchMode = 'option' | 'underlying';

export interface WatchSession {
  id: string;
  userId: string;
  strategyId: string;
  symbol: string;
  /**
   * ⚠️ LEGACY MIRROR — do not read these two directly.
   *
   * Before 2026-08-18 a watch named ONE leg, and these were it. Rows created
   * then still carry only these, so they cannot be dropped without losing
   * every pre-existing watch. New rows keep them populated from the FOCUSED
   * leg purely so those older readers and this history stay coherent.
   *
   * `watchLegs()` in `watchState.ts` is the one place that knows about this
   * shim: it returns the pair from `ce`/`pe` when present and reconstructs a
   * single-leg pair from these when not. Every consumer goes through it, which
   * is what keeps "legacy row" a migration detail rather than a second live
   * code path.
   */
  strike: string | null;
  optionType: OptionType | null;
  expiry: string | null;
  /** The CALL leg under observation. Null on an underlying watch. */
  ce: WatchLeg | null;
  /** The PUT leg under observation. Null on an underlying watch. */
  pe: WatchLeg | null;
  /** Which leg the engine evaluates the strategy rules against. */
  focusedSide: OptionType | null;
  watchMode: WatchMode;
  /** The bars the engine reads, from the strategy's own rules. */
  timeframe: string | null;
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

/**
 * The complete watch configuration "Start watching" sends.
 *
 * ── WHAT THIS REPLACED, AND WHY IT IS NOT OPTIONAL ─────────────────────────
 *
 * This used to be `{ strategyId, symbol, strike, optionType, expiry }` — one
 * numeric strike and the side the CE/PE toggle happened to be on. Sentinel
 * cannot compare the two candidate expressions of an underlying move from one
 * of them, so the pair is now the unit: both legs travel, both with their own
 * resolved instrument, and `focusedSide` says which one the rules run on
 * WITHOUT deciding which one exists.
 *
 * `ce`/`pe` are null only for `watchMode: 'underlying'`, where there are
 * genuinely no legs — never for "we could not resolve one". A leg that failed
 * to resolve blocks the request instead of travelling as null; see
 * `validateWatchPair`.
 */
export interface CreateWatchInput {
  strategyId: string;
  symbol: string;
  expiry: string | null;
  ce: WatchLeg | null;
  pe: WatchLeg | null;
  focusedSide: OptionType;
  watchMode: WatchMode;
  timeframe: string;
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
