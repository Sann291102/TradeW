import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { classifyFault, splitFault } from './faults';
import { sentinelKeys } from './queryKeys';

/**
 * The rule that decides whether a failure takes the Sentinel workspace off the
 * screen or puts a strip above it.
 *
 * Worth asserting because getting it wrong is invisible until it is in front
 * of a user: too eager and a 429 that lasted 900ms wipes out a working
 * workspace and demands a reload; too lax and someone whose subscription
 * lapsed watches "reconnecting…" forever over data that will never refresh.
 */

const cached = true;
const nothingCached = false;

describe('splitFault — banner or empty state', () => {
  it('reports neither when nothing has failed', () => {
    expect(splitFault(null, null, cached)).toEqual({ terminal: null, transient: null });
  });

  it('is a banner while a transient fault is still being retried', () => {
    // `error` is null: React Query has not given up yet. This is the window —
    // seconds of backoff — in which the old code said nothing at all and the
    // user reached for the reload button.
    const split = splitFault(null, new ApiError('too many requests', 429), nothingCached);
    expect(split.transient).toEqual({ kind: 'service-error', status: 429, message: 'too many requests' });
    expect(split.terminal).toBeNull();
  });

  it('stays a banner once retries are exhausted, IF something is cached', () => {
    // The last observation, the saved strategies and the forms are all still
    // worth looking at. Replacing them describes a failure by destroying the
    // thing that survived it.
    const split = splitFault(new ApiError('bad gateway', 502), null, cached);
    expect(split.transient).not.toBeNull();
    expect(split.terminal).toBeNull();
  });

  it('becomes the empty state only when retries are exhausted AND nothing is cached', () => {
    const split = splitFault(new ApiError('bad gateway', 502), null, nothingCached);
    expect(split.terminal).toEqual({ kind: 'service-error', status: 502, message: 'bad gateway' });
    expect(split.transient).toBeNull();
  });

  it('never hides "not signed in" behind a reconnecting banner', () => {
    // A decision, not a hiccup. Retrying it changes nothing, and pretending
    // otherwise over cached data keeps the user from the one action that works.
    const split = splitFault(null, new ApiError('unauthorized', 401), cached);
    expect(split.terminal).toEqual({ kind: 'unauthenticated' });
    expect(split.transient).toBeNull();
  });

  it('never hides a lapsed entitlement behind a reconnecting banner', () => {
    const split = splitFault(new ApiError('forbidden', 403), null, cached);
    expect(split.terminal).toEqual({ kind: 'entitlement-required' });
    expect(split.transient).toBeNull();
  });

  it('treats an unreachable API as transient — it comes back on its own', () => {
    const split = splitFault(null, new TypeError('Failed to fetch'), cached);
    expect(split.transient).toEqual({ kind: 'api-unreachable' });
    expect(split.terminal).toBeNull();
  });

  it('classifies the live failure, not a stale one, when both are present', () => {
    // `error` wins: it is the settled outcome, `failureReason` the attempt.
    expect(splitFault(new ApiError('gone', 404), new ApiError('busy', 429), cached).terminal).toEqual(
      classifyFault(new ApiError('gone', 404)),
    );
  });
});

/**
 * Two components reading one endpoint under two keys are two cache entries and
 * therefore two HTTP requests — against a bucket that is metered per IP. And a
 * mutation that invalidates a key nobody reads under invalidates nothing,
 * which is the whole "saved strategies don't appear until I reload" bug.
 *
 * Neither failure shows up in a type error, so the keys are pinned here.
 */
describe('sentinelKeys — deduplication and invalidation depend on these', () => {
  it('gives the same inputs the same key, so callers share one request', () => {
    expect(sentinelKeys.observe('u1', 'NIFTY', 'auto', [])).toEqual(
      sentinelKeys.observe('u1', 'NIFTY', 'auto', []),
    );
    expect(sentinelKeys.watches('u1')).toEqual(sentinelKeys.watches('u1'));
  });

  it('is order-insensitive about the pinned strategy set', () => {
    // The same two strategies chosen in a different order is the same
    // observation, and must not be a second cache entry and a second request.
    expect(sentinelKeys.observe('u1', 'NIFTY', 'manual', ['b', 'a'])).toEqual(
      sentinelKeys.observe('u1', 'NIFTY', 'manual', ['a', 'b']),
    );
  });

  it('separates markets, so switching back renders from cache instead of refetching blind', () => {
    expect(sentinelKeys.observe('u1', 'NIFTY', 'auto', [])).not.toEqual(
      sentinelKeys.observe('u1', 'BANKNIFTY', 'auto', []),
    );
  });

  it('scopes every key to the user', () => {
    // The cache outlives a sign-out. Without this the next account to sign in
    // could be handed the previous one's strategies out of cache.
    expect(sentinelKeys.strategies('u1')).not.toEqual(sentinelKeys.strategies('u2'));
    expect(sentinelKeys.watches('u1')).not.toEqual(sentinelKeys.watches(null));
  });

  it('matches the key names the task contract names', () => {
    expect(sentinelKeys.strategies('u1')).toEqual(['strategies', 'u1']);
    expect(sentinelKeys.watches('u1')).toEqual(['watches', 'u1']);
  });

  it('nests a watch timeline under the watches key, so one invalidation covers both', () => {
    const timeline = sentinelKeys.timeline('u1', 'w1');
    expect(timeline.slice(0, 2)).toEqual(sentinelKeys.watches('u1'));
  });
});
