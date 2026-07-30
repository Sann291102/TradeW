import { api, API_URL, ApiError, getToken } from './api';
import type { OrderDto, PlaceOrderRequest } from './oms';

/**
 * Discipline session client — talks to services/api's `/discipline/*` routes
 * and wraps the order path's limit response.
 *
 * The limits themselves are enforced in the OMS, not here. Everything in this
 * file is presentation: it reads what the server decided and shapes it for the
 * UI. In particular the 20s dwell and the 40-character minimum are re-checked
 * server-side on every retry — the numbers below come from the server's own
 * 409 payload so the countdown shown to the trader is the one actually being
 * enforced, not a second copy that could drift from it.
 */

export type DisciplineLimit = 'MAX_TRADES' | 'MAX_LOSS' | 'MAX_MINUTES';

export interface SessionBudget {
  elapsedMinutes: number;
  remainingMinutes: number;
  tradesTaken: number;
  remainingTrades: number;
  realizedPnl: number;
  remainingLoss: number;
  targetProfit: number | null;
  targetReached: boolean;
  breachedLimits: DisciplineLimit[];
}

export interface DisciplineOverrideDto {
  id: string;
  limitType: DisciplineLimit;
  reason: string;
  createdAt: string;
}

export interface DisciplineSessionDto {
  id: string;
  tradingDate: string;
  maxMinutes: number;
  maxTrades: number;
  maxLoss: number;
  targetProfit: number | null;
  startedAt: string;
  budget: SessionBudget;
  overrides: DisciplineOverrideDto[];
}

export interface DisciplineTodayDto {
  needsPanel: boolean;
  reason: 'session_exists' | 'not_a_trading_day' | 'before_market_open' | 'needs_panel';
  tradingDate: string;
  session: DisciplineSessionDto | null;
}

export interface StartSessionRequest {
  maxMinutes: number;
  maxTrades: number;
  maxLoss: number;
  targetProfit?: number | null;
}

export function fetchToday(): Promise<DisciplineTodayDto> {
  return api('/discipline/today');
}

export function startSession(req: StartSessionRequest): Promise<DisciplineSessionDto> {
  return api('/discipline/today', { method: 'POST', body: JSON.stringify(req) });
}

export function fetchOverrideHistory(params: { limitType?: DisciplineLimit; limit?: number } = {}) {
  const query = new URLSearchParams();
  if (params.limitType) query.set('limitType', params.limitType);
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return api(`/discipline/overrides${qs ? `?${qs}` : ''}`) as Promise<
    Array<{ id: string; tradingDate: string; limitType: DisciplineLimit; reason: string; createdAt: string }>
  >;
}

// ------------------------------------------------------- order-path friction

/**
 * The 409 the OMS raises when an order would cross a limit the trader set.
 *
 * Not an error in the product sense — it is the friction prompt's payload. The
 * order was neither placed nor refused; it is waiting on the trader to sit with
 * it and say why.
 */
export class DisciplineBreachError extends Error {
  readonly limitType: DisciplineLimit;
  readonly detail: { limit: number; current: number };
  readonly overrideToken: string;
  readonly minDwellMs: number;
  readonly minReasonLength: number;
  /** Set when a RETRY was refused — why the server sent the trader back. */
  readonly priorAttempt: string | null;
  readonly budget: SessionBudget;

  constructor(payload: DisciplineBreachPayload) {
    super(`discipline limit ${payload.limitType}`);
    this.name = 'DisciplineBreachError';
    this.limitType = payload.limitType;
    this.detail = payload.detail;
    this.overrideToken = payload.overrideToken;
    this.minDwellMs = payload.minDwellMs;
    this.minReasonLength = payload.minReasonLength;
    this.priorAttempt = payload.priorAttempt ?? null;
    this.budget = payload.budget;
  }
}

interface DisciplineBreachPayload {
  error: 'discipline_limit';
  limitType: DisciplineLimit;
  detail: { limit: number; current: number };
  overrideToken: string;
  minDwellMs: number;
  minReasonLength: number;
  priorAttempt: string | null;
  budget: SessionBudget;
}

export interface PlaceOrderWithOverride extends PlaceOrderRequest {
  overrideToken?: string;
  overrideReason?: string;
}

/**
 * Place an order, translating the discipline 409 into a typed throw.
 *
 * Lives here rather than in `oms.ts` so the OMS client stays a plain mirror of
 * `/sim/*` and everything discipline-shaped is in one file. Callers that never
 * show the friction prompt can keep using `oms.placeOrder` unchanged.
 *
 * `api()` collapses a non-OK response into an `ApiError` carrying only the
 * status, so this issues the request directly to read the 409's body — the
 * override token and the enforced timings live in there.
 */
export async function placeOrderWithDiscipline(req: PlaceOrderWithOverride): Promise<OrderDto> {
  const token = getToken();
  const res = await fetch(`${API_URL}/sim/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(req),
  });

  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { message?: DisciplineBreachPayload } | null;
    // Nest wraps a thrown ConflictException(object) as { message: <object> }.
    const payload = body?.message;
    if (payload?.error === 'discipline_limit') throw new DisciplineBreachError(payload);
    // A 409 that isn't a limit breach (e.g. a replayed override) is a real
    // failure — surface it rather than swallowing it into the prompt.
    throw new ApiError(describeConflict(body), 409);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    throw new ApiError(typeof body?.message === 'string' ? body.message : `Request failed (${res.status})`, res.status);
  }

  return res.json();
}

function describeConflict(body: { message?: unknown } | null): string {
  const message = (body?.message ?? null) as { message?: string } | string | null;
  if (typeof message === 'string') return message;
  if (message && typeof message.message === 'string') return message.message;
  return 'That order could not be placed. Try again.';
}

// -------------------------------------------------------------------- copy

/**
 * Friction-prompt copy, per limit. Authored and reviewed as static strings —
 * deliberately NOT routed through Sentinel's vocabulary enforcer, whose bare
 * `\bexit\b` / `\btarget\b` rewrites would mangle legitimate wording here.
 *
 * Compliance: none of this names an instrument, a direction, or a market
 * expectation. It restates a limit the trader set for themselves.
 */
export function frictionHeading(limitType: DisciplineLimit): string {
  switch (limitType) {
    case 'MAX_TRADES':
      return "You've hit the trade count you set";
    case 'MAX_LOSS':
      return "You've reached the loss limit you set";
    case 'MAX_MINUTES':
      return "You've been trading longer than you planned";
  }
}

/** Body copy with the trader's own figures substituted in. */
export function frictionBody(limitType: DisciplineLimit, detail: { limit: number; current: number }): string {
  const inr0 = (n: number) => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n));
  switch (limitType) {
    case 'MAX_TRADES':
      return `At the start of the session you set a maximum of ${detail.limit} trades. This would be number ${detail.current + 1}.`;
    case 'MAX_LOSS':
      return `You set a maximum loss of ${inr0(detail.limit)} for today. Realised P&L is currently −${inr0(detail.current)}.`;
    case 'MAX_MINUTES':
      return `You set a ${detail.limit}-minute session. It's been ${detail.current} minutes since you started.`;
  }
}

/**
 * Why the server sent a retry back. Only ever shown after a refused attempt,
 * so it reads as a correction rather than an accusation up front.
 */
export function priorAttemptMessage(priorAttempt: string): string {
  switch (priorAttempt) {
    case 'too_fast':
      return 'That came back too quickly — the wait has to actually pass. It has been restarted.';
    case 'too_short':
      return 'That reason was too short. It has to be at least 40 characters.';
    case 'low_effort':
      return 'That reason looks like filler. Write it in your own words.';
    case 'expired':
      return 'That prompt had been open too long, so it expired. Here it is again.';
    case 'wrong_session':
    case 'wrong_limit':
    case 'bad_signature':
      return 'That override no longer matched this order, so it was not accepted. Here is a fresh prompt.';
    default:
      return 'That attempt was not accepted. Here is a fresh prompt.';
  }
}
