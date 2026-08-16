import { ApiError } from '@/lib/api';

/**
 * When a failed Sentinel request is worth trying again, and how long to wait.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `/sentinel/observe` used to be a one-shot fetch on mount. If it came back
 * 429 or 503 — which it did, routinely — the workspace latched into a
 * permanent "Sentinel service not connected" card and the ONLY way out was a
 * full browser reload. Reloading worked for a reason that gives the whole game
 * away: the request was fine, the first attempt just landed inside a rate-limit
 * window that had already expired by the time the user hit F5.
 *
 * So the fix is not a better error message. It is retrying, on the schedule the
 * server actually asked for.
 *
 * ── WHAT IS AND IS NOT RETRYABLE ───────────────────────────────────────────
 *
 * A 401 or 403 is a decision, not a hiccup: `AuthGuard` said there is no
 * session, or `CapabilityGuard` said this account is not entitled (see
 * `faults.ts` for why those two are never collapsed). Retrying either one
 * changes nothing and, worse, hides a state the user has to act on behind
 * three rounds of "reconnecting…". Same for 404 and every other 4xx that is
 * not 408/429.
 *
 * What IS retryable is the set of faults that are true of this MOMENT rather
 * than of this request: 429 (rate limited), 502/503/504 (the service behind
 * the route is restarting or overloaded), 408 (timeout), and a thrown
 * TypeError from `fetch` itself, which means the API was unreachable — the
 * exact shape of `services/api` not being up yet while the browser is.
 *
 * ── JITTER IS NOT DECORATION ───────────────────────────────────────────────
 *
 * `services/api` rate-limits by CLIENT IP (services/api/src/common/throttling.ts),
 * not by user. Everyone in one office shares a bucket. A fixed backoff means
 * ten clients that were rate-limited by the same burst all come back at
 * *exactly* the same millisecond and rate-limit each other again, forever. The
 * random component breaks that lockstep, which is the whole reason it is here.
 */

/** Retryable HTTP statuses. Everything else is a decision, not a hiccup. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** How many times a transient failure is retried before the UI gives up. */
export const MAX_RETRIES = 3;

/** Base delay for a generic transient fault: 1s, 2s, 4s. */
const BASE_DELAY_MS = 1_000;

/**
 * Base delay for a 429 with no `Retry-After`. Starts higher than the generic
 * case because a rate-limit window is measured in seconds, so coming back in
 * one is a guaranteed second 429.
 */
const RATE_LIMIT_BASE_DELAY_MS = 2_000;

/** Ceiling so a long outage does not push the next attempt minutes away. */
const MAX_DELAY_MS = 30_000;

/** Upper bound of the random component added to every computed delay. */
export const JITTER_MS = 500;

export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/**
 * True when the failure is about this moment rather than about this request.
 * A non-`ApiError` reaches here only when `fetch` itself threw, which means
 * the API was unreachable — retryable by definition.
 */
export function isTransientFault(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_STATUSES.has(error.status);
  return true;
}

/**
 * React Query's `retry` predicate. `failureCount` is how many attempts have
 * already failed, so it is 1 when deciding whether to make the second attempt.
 */
export function shouldRetry(failureCount: number, error: unknown, max: number = MAX_RETRIES): boolean {
  return failureCount < max && isTransientFault(error);
}

/**
 * React Query's `retryDelay`. `attemptIndex` is 0-based (0 before the first
 * retry), matching what React Query passes.
 *
 * `Retry-After` wins over everything else when present: `@nestjs/throttler`
 * sets it to the exact number of seconds left in the bucket window, so any
 * shorter wait can only produce another 429 and burn the very budget being
 * waited for. `random` is injected so this is deterministic under test.
 */
export function retryDelayMs(attemptIndex: number, error: unknown, random: () => number = Math.random): number {
  const jitter = Math.floor(random() * JITTER_MS);

  if (error instanceof ApiError && error.retryAfterSeconds !== null) {
    // Not clamped to MAX_DELAY_MS: the server named this number, and waiting
    // less than it asked for is how a client earns a longer ban.
    return error.retryAfterSeconds * 1000 + jitter;
  }

  const base = isRateLimited(error) ? RATE_LIMIT_BASE_DELAY_MS : BASE_DELAY_MS;
  return Math.min(base * 2 ** attemptIndex, MAX_DELAY_MS) + jitter;
}

/**
 * One line, logged once per rate-limited response, so a 429 storm is visible
 * in a console rather than inferred from the UI going quiet.
 */
export function logIfRateLimited(error: unknown, label: string): void {
  if (!isRateLimited(error)) return;
  const after = error instanceof ApiError ? error.retryAfterSeconds : null;
  // eslint-disable-next-line no-console
  console.warn(
    `Rate limited by Sentinel, backing off (${label})${after !== null ? ` — Retry-After ${after}s` : ''}`,
  );
}

// --- poll cadence ------------------------------------------------------------

/**
 * How often a live Sentinel surface re-reads, in milliseconds.
 *
 * Three cadences, because polling at one rate is either wasteful or stale
 * depending on whether anything is actually happening:
 *
 *   · active  — the user has at least one live watch, so a state change is
 *               something they are sitting there waiting for.
 *   · idle    — nothing is being watched; the read is context, not an alert.
 *   · failing — the last attempt failed. Polling a service that is refusing
 *               requests at the same rate is how a rate limit becomes a
 *               self-inflicted outage, so the cadence backs off until it
 *               recovers. The first success returns it to normal immediately.
 *
 * NOTE ON COST. `/sentinel/observe` fans out to the intelligence engines and
 * the Brain, and services/api meters it at 30/min PER CLIENT IP
 * (EXPENSIVE_LIMIT). At the active cadence that is 6 calls/min/tab, so an
 * office sharing one egress IP reaches the ceiling at ~5 concurrent tabs.
 * These are the numbers to raise first if 429s persist after the deduplication
 * and remount fixes.
 */
export const POLL_ACTIVE_MS = 10_000;
export const POLL_IDLE_MS = 30_000;
export const POLL_FAILING_MS = 60_000;

export interface PollCadenceInput {
  /** The user has at least one watch that has not exited. */
  hasActiveWatches: boolean;
  /** The last attempt for this query failed. */
  failing: boolean;
}

export function pollIntervalMs({ hasActiveWatches, failing }: PollCadenceInput): number {
  if (failing) return POLL_FAILING_MS;
  return hasActiveWatches ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}
