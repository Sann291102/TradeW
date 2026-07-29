import { describe, expect, it } from 'vitest';
import { PUBLIC_FEED_ROUTES, feedRewrites, isAllowedFeedPath } from './feed-proxy-routes.mjs';

/**
 * The feed proxy allowlist.
 *
 * The bridge behind `/feed` has no authentication, so this list is the entire
 * boundary between it and the internet. The regression these tests exist to
 * catch is the previous `/feed/:path*` behaviour: a route added to the bridge
 * becoming publicly reachable with no change here and no review.
 */

describe('isAllowedFeedPath — allows the public market-data routes', () => {
  for (const route of PUBLIC_FEED_ROUTES) {
    it(`allows ${route}`, () => {
      expect(isAllowedFeedPath(route)).toBe(true);
    });
  }

  it('ignores a query string when matching', () => {
    expect(isAllowedFeedPath('/quotes?symbols=NIFTY,BANKNIFTY')).toBe(true);
    expect(isAllowedFeedPath('/candles?symbol=NIFTY&interval=5')).toBe(true);
  });

  it('tolerates a trailing slash and duplicate slashes', () => {
    expect(isAllowedFeedPath('/quotes/')).toBe(true);
    expect(isAllowedFeedPath('//quotes')).toBe(true);
    expect(isAllowedFeedPath('/optionchain//expirylist')).toBe(true);
  });
});

describe('isAllowedFeedPath — refuses everything else', () => {
  it('refuses a route the bridge does not currently have', () => {
    // The whole point: a future internal route is closed until it is listed.
    for (const path of [
      '/admin',
      '/credentials',
      '/token',
      '/internal/positions',
      '/users/user-alice/orders',
      '/debug',
      '/metrics',
      '/env',
    ]) {
      expect(isAllowedFeedPath(path)).toBe(false);
    }
  });

  it('refuses paths that merely extend an allowed route', () => {
    // Exact match, not prefix match — `/status/../admin` style pivots and
    // `/quotesX` typo-squats both fail.
    for (const path of ['/quotes/extra', '/status/detail', '/quotesX', '/streaming']) {
      expect(isAllowedFeedPath(path)).toBe(false);
    }
  });

  it('refuses path traversal rather than resolving it', () => {
    for (const path of [
      '/quotes/../admin',
      '/../admin',
      '/./admin',
      '/quotes/./../secret',
      '/a/b/../../../etc/passwd',
    ]) {
      expect(isAllowedFeedPath(path)).toBe(false);
    }
  });

  it('refuses percent-encoded paths outright', () => {
    // `%2e%2e` / `%2f` are how an exact-match allowlist is normally bypassed.
    for (const path of ['/%2e%2e/admin', '/quotes%2f..%2fadmin', '/%71uotes', '/quotes%00']) {
      expect(isAllowedFeedPath(path)).toBe(false);
    }
  });

  it('refuses empty and non-string input', () => {
    for (const value of ['', null, undefined, 42, {}, []]) {
      expect(isAllowedFeedPath(value)).toBe(false);
    }
  });

  it('refuses a bare root', () => {
    expect(isAllowedFeedPath('/')).toBe(false);
  });
});

describe('feedRewrites', () => {
  const rewrites = feedRewrites('http://127.0.0.1:4600');

  it('emits one exact rewrite per allowlisted route and nothing more', () => {
    expect(rewrites).toHaveLength(PUBLIC_FEED_ROUTES.length);
    expect(rewrites.map((r) => r.source)).toEqual(PUBLIC_FEED_ROUTES.map((r) => `/feed${r}`));
  });

  it('contains no wildcard or parameter pattern', () => {
    // A `:path*` anywhere here would restore the original exposure. Compared on
    // the PATH only — the destination's authority legitimately contains a colon
    // for the port, which is not a route parameter.
    for (const { source, destination } of rewrites) {
      expect(source).not.toMatch(/[:*]/);
      expect(new URL(destination).pathname).not.toMatch(/[:*]/);
    }
  });

  it('points every route at the configured bridge origin', () => {
    for (const { destination } of rewrites) {
      expect(destination.startsWith('http://127.0.0.1:4600/')).toBe(true);
    }
  });

  it('every generated source maps back to an allowed path', () => {
    for (const { source } of rewrites) {
      expect(isAllowedFeedPath(source.replace(/^\/feed/, ''))).toBe(true);
    }
  });
});
