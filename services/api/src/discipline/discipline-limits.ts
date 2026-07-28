/**
 * Discipline limits — pure decision logic.
 *
 * Deliberately free of Nest, Prisma and I/O so the rules a trader's money
 * depends on can be tested directly. `DisciplineService` does the database
 * work and calls into here; nothing in this file reads the clock on its own
 * (every function takes `at`) or the environment (the token secret is passed
 * in), which is what makes the tests deterministic.
 *
 * Numbers here are plain `number` in rupees, not Prisma `Decimal` — the
 * service converts at the boundary. These are threshold comparisons against
 * user-entered whole-rupee limits, not currency arithmetic that accumulates,
 * so float is adequate and keeps the module dependency-free.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type DisciplineLimit = 'MAX_TRADES' | 'MAX_LOSS' | 'MAX_MINUTES';

/** How long the trader must sit with the friction prompt before it will let
 *  them through. Enforced HERE, server-side, because a client-only countdown
 *  is bypassable with curl — and being hard to get past is the whole feature. */
export const MIN_DWELL_MS = 20_000;

/** An override token older than this is dead; the trader re-reads the prompt. */
export const MAX_TOKEN_AGE_MS = 10 * 60_000;

/** Minimum characters of typed reason. Long enough to require a sentence. */
export const MIN_REASON_LENGTH = 40;

// ---------------------------------------------------------------- session

/** The counter/limit state a breach decision needs. */
export interface SessionLimits {
  maxMinutes: number;
  maxTrades: number;
  /** Positive magnitude, e.g. 5000 means "stop me at ₹5,000 down". */
  maxLoss: number;
  targetProfit: number | null;
  startedAt: Date;
  tradesTaken: number;
  /** Signed: negative when down on the day. */
  realizedPnl: number;
}

export interface Breach {
  limitType: DisciplineLimit;
  /** Machine-readable figures; the client renders the copy, not the server. */
  detail: {
    limit: number;
    current: number;
  };
}

/**
 * The three checks, in the order the product specifies: trade count, then loss,
 * then elapsed time. First breach wins — the trader is told the one thing they
 * crossed, not handed a list.
 *
 * Returns null when nothing is breached. Note this is called only for orders
 * that INCREASE exposure (see `computeOrderIntent`); closing a position is
 * never frictioned.
 */
export function evaluateBreach(session: SessionLimits, at: Date): Breach | null {
  if (session.tradesTaken >= session.maxTrades) {
    return {
      limitType: 'MAX_TRADES',
      detail: { limit: session.maxTrades, current: session.tradesTaken },
    };
  }

  // maxLoss is a magnitude; realizedPnl is signed. -5000 <= -5000 breaches.
  if (session.realizedPnl <= -session.maxLoss) {
    return {
      limitType: 'MAX_LOSS',
      detail: { limit: session.maxLoss, current: session.realizedPnl },
    };
  }

  const elapsedMinutes = elapsedMinutesSince(session.startedAt, at);
  if (elapsedMinutes >= session.maxMinutes) {
    return {
      limitType: 'MAX_MINUTES',
      detail: { limit: session.maxMinutes, current: elapsedMinutes },
    };
  }

  return null;
}

/** Whole minutes elapsed, floored, never negative (a clock skew that puts
 *  `at` before `startedAt` reads as 0 elapsed, not as a negative session). */
export function elapsedMinutesSince(startedAt: Date, at: Date): number {
  return Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / 60_000));
}

/**
 * True when the profit target exists, has been reached, and the one-time
 * notice has not already gone out. The `targetNoticeSentAt` half is what makes
 * it fire once per session rather than once per fill.
 */
export function shouldSendTargetNotice(
  session: Pick<SessionLimits, 'targetProfit' | 'realizedPnl'> & { targetNoticeSentAt: Date | null },
): boolean {
  if (session.targetProfit === null || session.targetProfit <= 0) return false;
  if (session.targetNoticeSentAt !== null) return false;
  return session.realizedPnl >= session.targetProfit;
}

// ----------------------------------------------------------------- intent

export type OrderIntent = 'open' | 'reduce';

/**
 * Does this order increase or reduce the trader's exposure?
 *
 * Only `open` orders are subject to the limits. A `reduce` order is never
 * frictioned, and that exemption is the point: the loss limit is breached
 * precisely when the trader is holding a losing position, and making them type
 * a paragraph before they can close it would keep them in the trade the
 * feature exists to protect them from.
 *
 * Computed from the position the server already holds, never from a
 * client-supplied flag — a flag would be trivially forged to skip the prompt.
 *
 * A flip (long 100, SELL 150) counts as `open`: it closes 100 and opens 50
 * short, and the opening half is new exposure taken after a breach.
 */
export function computeOrderIntent(
  existingQty: number,
  side: 'BUY' | 'SELL',
  quantity: number,
): OrderIntent {
  if (existingQty === 0) return 'open';
  const delta = side === 'BUY' ? quantity : -quantity;
  // Same direction as the existing position — adding to it.
  if (Math.sign(existingQty) === Math.sign(delta)) return 'open';
  // Opposite direction: a reduction only if it does not overshoot into a flip.
  return quantity <= Math.abs(existingQty) ? 'reduce' : 'open';
}

// ------------------------------------------------------------------ reason

export type ReasonRejection = 'too_short' | 'low_effort';

/**
 * Is the typed reason a real one?
 *
 * Length alone is trivially defeated by holding down a key, so this also
 * rejects text with too little variety. Not a content judgement — a reason can
 * say anything at all, it just has to have been written.
 */
export function validateReason(raw: string | undefined | null): ReasonRejection | null {
  const reason = (raw ?? '').trim();
  if (reason.length < MIN_REASON_LENGTH) return 'too_short';

  // "aaaaaaa..." or "asdfasdfasdf..." — a handful of distinct characters
  // stretched to length. Real sentences clear this comfortably.
  const distinct = new Set(reason.toLowerCase().replace(/\s/g, '')).size;
  if (distinct < 10) return 'low_effort';

  // A single word repeated to length.
  const words = reason.split(/\s+/).filter(Boolean);
  if (words.length >= 4 && new Set(words.map((w) => w.toLowerCase())).size <= 2) {
    return 'low_effort';
  }

  return null;
}

// ------------------------------------------------------------------- token

/**
 * The friction prompt's proof-of-work, as a signed string rather than server
 * state: `sessionId.limitType.issuedAtMs.nonce.hmac`.
 *
 * Signing keeps the issuing side stateless. Single use is NOT enforced here —
 * it is enforced by the unique index on `DisciplineOverride.tokenNonce`, so
 * that two concurrent orders replaying one token collide in Postgres rather
 * than racing an in-memory set.
 */
export interface OverrideToken {
  sessionId: string;
  limitType: DisciplineLimit;
  issuedAt: number;
  nonce: string;
}

export type TokenRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'too_fast'
  | 'wrong_session'
  | 'wrong_limit';

export function issueOverrideToken(
  sessionId: string,
  limitType: DisciplineLimit,
  secret: string,
  at: Date,
): string {
  const nonce = randomBytes(16).toString('base64url');
  const body = `${sessionId}.${limitType}.${at.getTime()}.${nonce}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token against the session it claims, the limit it claims, and the
 * clock. Returns the parsed token or the reason it was refused.
 *
 * The dwell check lives here rather than in the UI on purpose — see
 * MIN_DWELL_MS.
 */
export function verifyOverrideToken(
  token: string | undefined | null,
  expected: { sessionId: string; limitType: DisciplineLimit },
  secret: string,
  at: Date,
): { ok: true; token: OverrideToken } | { ok: false; reason: TokenRejection } {
  if (!token) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const [sessionId, limitType, issuedAtRaw, nonce, signature] = parts;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return { ok: false, reason: 'malformed' };
  if (limitType !== 'MAX_TRADES' && limitType !== 'MAX_LOSS' && limitType !== 'MAX_MINUTES') {
    return { ok: false, reason: 'malformed' };
  }

  const body = `${sessionId}.${limitType}.${issuedAtRaw}.${nonce}`;
  if (!verify(body, signature, secret)) return { ok: false, reason: 'bad_signature' };

  // Signature checked before any claim is trusted, so the comparisons below
  // are against values the server itself issued.
  if (sessionId !== expected.sessionId) return { ok: false, reason: 'wrong_session' };
  if (limitType !== expected.limitType) return { ok: false, reason: 'wrong_limit' };

  const age = at.getTime() - issuedAt;
  if (age > MAX_TOKEN_AGE_MS) return { ok: false, reason: 'expired' };
  // A negative age (token issued "in the future") is clock skew, not a valid
  // wait — treat it as not having waited.
  if (age < MIN_DWELL_MS) return { ok: false, reason: 'too_fast' };

  return { ok: true, token: { sessionId, limitType, issuedAt, nonce } };
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function verify(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ------------------------------------------------------------------ budget

/** What the read-only session view shows. Derived, never stored. */
export interface SessionBudget {
  elapsedMinutes: number;
  remainingMinutes: number;
  tradesTaken: number;
  remainingTrades: number;
  realizedPnl: number;
  /** Rupees of loss budget left; 0 once spent, never negative. */
  remainingLoss: number;
  targetProfit: number | null;
  targetReached: boolean;
  /** True for any limit already crossed — the view marks it, nothing blocks. */
  breachedLimits: DisciplineLimit[];
}

export function computeBudget(session: SessionLimits, at: Date): SessionBudget {
  const elapsedMinutes = elapsedMinutesSince(session.startedAt, at);
  const breachedLimits: DisciplineLimit[] = [];
  if (session.tradesTaken >= session.maxTrades) breachedLimits.push('MAX_TRADES');
  if (session.realizedPnl <= -session.maxLoss) breachedLimits.push('MAX_LOSS');
  if (elapsedMinutes >= session.maxMinutes) breachedLimits.push('MAX_MINUTES');

  return {
    elapsedMinutes,
    remainingMinutes: Math.max(0, session.maxMinutes - elapsedMinutes),
    tradesTaken: session.tradesTaken,
    remainingTrades: Math.max(0, session.maxTrades - session.tradesTaken),
    realizedPnl: session.realizedPnl,
    // Only losses eat the budget — a profitable session has its full loss
    // budget intact, it does not "gain" extra room.
    remainingLoss: Math.max(0, session.maxLoss + Math.min(0, session.realizedPnl)),
    targetProfit: session.targetProfit,
    targetReached:
      session.targetProfit !== null &&
      session.targetProfit > 0 &&
      session.realizedPnl >= session.targetProfit,
    breachedLimits,
  };
}

// ------------------------------------------------------------- input bounds

/** Rejection reasons for the panel's own submitted limits. */
export type LimitsRejection =
  | 'max_minutes_out_of_range'
  | 'max_trades_out_of_range'
  | 'max_loss_out_of_range'
  | 'target_profit_out_of_range';

export const LIMIT_BOUNDS = {
  maxMinutes: { min: 5, max: 24 * 60 },
  maxTrades: { min: 1, max: 500 },
  maxLoss: { min: 1, max: 100_000_000 },
  targetProfit: { min: 1, max: 100_000_000 },
} as const;

/**
 * Bounds-check the three required limits and the optional target.
 *
 * Upper bounds exist so a limit cannot be set to something that silently means
 * "no limit" — `maxTrades: 999999` would make the whole feature decorative
 * while still looking configured on the session view.
 */
export function validateLimits(input: {
  maxMinutes: number;
  maxTrades: number;
  maxLoss: number;
  targetProfit?: number | null;
}): LimitsRejection | null {
  const { maxMinutes, maxTrades, maxLoss, targetProfit } = input;

  if (!Number.isInteger(maxMinutes) || maxMinutes < LIMIT_BOUNDS.maxMinutes.min || maxMinutes > LIMIT_BOUNDS.maxMinutes.max) {
    return 'max_minutes_out_of_range';
  }
  if (!Number.isInteger(maxTrades) || maxTrades < LIMIT_BOUNDS.maxTrades.min || maxTrades > LIMIT_BOUNDS.maxTrades.max) {
    return 'max_trades_out_of_range';
  }
  if (!Number.isFinite(maxLoss) || maxLoss < LIMIT_BOUNDS.maxLoss.min || maxLoss > LIMIT_BOUNDS.maxLoss.max) {
    return 'max_loss_out_of_range';
  }
  if (targetProfit !== undefined && targetProfit !== null) {
    if (!Number.isFinite(targetProfit) || targetProfit < LIMIT_BOUNDS.targetProfit.min || targetProfit > LIMIT_BOUNDS.targetProfit.max) {
      return 'target_profit_out_of_range';
    }
  }
  return null;
}
