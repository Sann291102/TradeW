import { describe, expect, it } from 'vitest';
import { ApiError, parseRetryAfter } from '@/lib/api';
import {
  JITTER_MS,
  MAX_RETRIES,
  POLL_ACTIVE_MS,
  POLL_FAILING_MS,
  POLL_IDLE_MS,
  isRateLimited,
  isTransientFault,
  pollIntervalMs,
  retryDelayMs,
  shouldRetry,
} from './retryPolicy';

/**
 * The rules that decide whether the Sentinel workspace recovers on its own or
 * sits there telling the user to reload.
 *
 * Asserted rather than eyeballed because every failure mode here is invisible
 * in a screenshot: a 403 that gets retried looks identical to one that does
 * not until the user has waited through three rounds of "reconnecting…" for an
 * answer that was never going to change, and a backoff with no jitter looks
 * perfect on one machine and locks a whole office out on ten.
 */

const noJitter = () => 0;

describe('isTransientFault — what is worth trying again', () => {
  it('retries the faults that are about this moment, not this request', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientFault(new ApiError('boom', status)), `HTTP ${status}`).toBe(true);
    }
  });

  it('does not retry a decision', () => {
    // 401 = AuthGuard found no session. 403 = CapabilityGuard found no
    // entitlement. Retrying either changes nothing and hides a state the user
    // has to act on behind a spinner. See faults.ts.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientFault(new ApiError('nope', status)), `HTTP ${status}`).toBe(false);
    }
  });

  it('treats a thrown fetch error as transient', () => {
    // Not an ApiError at all means the request never reached the server —
    // services/api is not up yet. That resolves by itself.
    expect(isTransientFault(new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('shouldRetry', () => {
  it('gives a transient fault three attempts and then stops', () => {
    const err = new ApiError('rate limited', 429);
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(true);
    expect(shouldRetry(MAX_RETRIES, err)).toBe(false);
  });

  it('never retries an entitlement failure, even on the first attempt', () => {
    expect(shouldRetry(0, new ApiError('forbidden', 403))).toBe(false);
  });

  it('honours a tighter cap for mutations', () => {
    expect(shouldRetry(0, new ApiError('bad gateway', 502), 1)).toBe(true);
    expect(shouldRetry(1, new ApiError('bad gateway', 502), 1)).toBe(false);
  });
});

describe('retryDelayMs — the backoff', () => {
  it('backs a generic transient fault off exponentially: 1s, 2s, 4s', () => {
    const err = new ApiError('unavailable', 503);
    expect(retryDelayMs(0, err, noJitter)).toBe(1_000);
    expect(retryDelayMs(1, err, noJitter)).toBe(2_000);
    expect(retryDelayMs(2, err, noJitter)).toBe(4_000);
  });

  it('starts a 429 higher, because a rate-limit window is measured in seconds', () => {
    // Coming back in one second is a guaranteed second 429.
    const err = new ApiError('too many requests', 429);
    expect(retryDelayMs(0, err, noJitter)).toBe(2_000);
    expect(retryDelayMs(1, err, noJitter)).toBe(4_000);
    expect(retryDelayMs(2, err, noJitter)).toBe(8_000);
  });

  it('obeys Retry-After over its own backoff', () => {
    // The server named the number. Waiting less than it asked for can only
    // produce another 429 and burn the budget being waited for.
    const err = new ApiError('too many requests', 429, 37);
    expect(retryDelayMs(0, err, noJitter)).toBe(37_000);
    // ...and does not let its own exponential creep past it on later attempts.
    expect(retryDelayMs(3, err, noJitter)).toBe(37_000);
  });

  it('caps its own backoff so a long outage does not push retries minutes out', () => {
    expect(retryDelayMs(20, new ApiError('down', 503), noJitter)).toBe(30_000);
  });

  it('adds jitter, so clients rate-limited by the same burst do not return in lockstep', () => {
    // services/api meters by CLIENT IP, so an office shares one bucket. A
    // fixed backoff means everyone comes back on the same millisecond and
    // rate-limits each other again — forever.
    const err = new ApiError('too many requests', 429);
    expect(retryDelayMs(0, err, () => 0)).toBe(2_000);
    expect(retryDelayMs(0, err, () => 0.999)).toBe(2_000 + JITTER_MS - 1);
    expect(retryDelayMs(0, err, () => 0.5)).toBeGreaterThan(retryDelayMs(0, err, () => 0));
  });

  it('jitters a Retry-After wait forwards only, never backwards', () => {
    const err = new ApiError('too many requests', 429, 5);
    expect(retryDelayMs(0, err, () => 0.999)).toBeGreaterThanOrEqual(5_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('12')).toBe(12);
  });

  it('reads an HTTP-date, relative to now', () => {
    const now = Date.parse('2026-08-15T10:00:00Z');
    expect(parseRetryAfter('Sat, 15 Aug 2026 10:00:30 GMT', now)).toBe(30);
  });

  it('clamps a date already in the past rather than retrying instantly', () => {
    const now = Date.parse('2026-08-15T10:00:00Z');
    expect(parseRetryAfter('Sat, 15 Aug 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('isRateLimited', () => {
  it('is true only for 429', () => {
    expect(isRateLimited(new ApiError('x', 429))).toBe(true);
    expect(isRateLimited(new ApiError('x', 503))).toBe(false);
    expect(isRateLimited(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('pollIntervalMs — the cadence', () => {
  it('polls fastest when the user has a live watch they are waiting on', () => {
    expect(pollIntervalMs({ hasActiveWatches: true, failing: false })).toBe(POLL_ACTIVE_MS);
  });

  it('slows down when nothing is being watched', () => {
    expect(pollIntervalMs({ hasActiveWatches: false, failing: false })).toBe(POLL_IDLE_MS);
  });

  it('backs off while failing, even with active watches', () => {
    // Polling a service that is already refusing requests at the same rate is
    // how a rate limit becomes a self-inflicted outage.
    expect(pollIntervalMs({ hasActiveWatches: true, failing: true })).toBe(POLL_FAILING_MS);
  });

  it('never polls faster than five seconds', () => {
    for (const failing of [true, false]) {
      for (const hasActiveWatches of [true, false]) {
        expect(pollIntervalMs({ hasActiveWatches, failing })).toBeGreaterThanOrEqual(5_000);
      }
    }
  });
});
