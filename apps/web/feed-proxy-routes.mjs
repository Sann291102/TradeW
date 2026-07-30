/**
 * The explicit allowlist of live-feed bridge routes the web origin will proxy.
 *
 * WHY AN ALLOWLIST INSTEAD OF `/feed/:path*`
 *
 * The bridge (services/market-data/scripts/live-feed-server.ts) has NO
 * authentication of its own — it was written as a localhost-only demo bridge.
 * `/feed/:path*` published every route it has, and every route it will ever
 * have, through the public web origin. Nothing today is user-scoped, so nothing
 * is currently exposed that should not be; the defect is structural, not
 * present-tense: the next route added to that file becomes internet-reachable by
 * default, with no change to this config and no review step that would catch it.
 *
 * Inverting the default fixes that. A new bridge route is unreachable from the
 * web origin until someone adds it here, which is a deliberate act in a file
 * whose whole subject is what may be public.
 *
 * EVERYTHING LISTED HERE IS PUBLIC AND UNAUTHENTICATED. The bar for adding a
 * route is not "the app needs it" — it is "this response is safe to serve to an
 * anonymous stranger". Public market data (quotes, candles, option chains,
 * instrument metadata) meets that bar. Anything scoped to a user, an account, a
 * position, an order or a broker credential does NOT, and must go through
 * services/api behind `AuthGuard` instead.
 *
 * Kept as a standalone .mjs module rather than inlined in next.config.mjs so the
 * allowlist can be unit-tested — see feed-proxy-routes.spec.mjs.
 */

/**
 * Exact paths, no parameters. Read-only public market data.
 *
 * Query strings are NOT part of the match: Next matches on path, and the bridge
 * reads its parameters from the query. That is fine — the query selects which
 * public instrument is being asked about, and the bridge validates it.
 */
export const PUBLIC_FEED_ROUTES = [
  // Bridge liveness + which Dhan token source is in use (no token material).
  '/status',
  // Live quote snapshots for the index/equity universe.
  '/quotes',
  // Instrument metadata resolved from the Dhan scrip master.
  '/instrument',
  '/instrument/option',
  // Historical OHLCV.
  '/candles',
  '/candles/option',
  // Option chain and its expiry list.
  '/optionchain',
  '/optionchain/expirylist',
  // WebSocket upgrade for streaming ticks. Listed because it was reachable
  // before this change and the dashboard depends on it; it carries the same
  // public tick data as /quotes.
  '/stream',
];

/**
 * Is this bridge path allowed through the proxy?
 *
 * Normalises before comparing so that `/quotes/`, `//quotes` and
 * `/./quotes` cannot slip past an exact-match check, and rejects any path
 * containing a `..` segment outright rather than trying to resolve it.
 *
 * @param {string} pathname a path relative to the bridge root, e.g. `/quotes`.
 * @returns {boolean}
 */
export function isAllowedFeedPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;

  // Strip a query or fragment if a caller passed a full path+query.
  const pathOnly = pathname.split('?')[0].split('#')[0];

  // Traversal is refused, not normalised away. There is no legitimate `..` in a
  // bridge route, so its presence is a probe and the honest response is "no".
  const segments = pathOnly.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return false;

  // Collapse duplicate slashes, drop a single trailing slash, and require a
  // leading one.
  const collapsed = `/${segments.filter(Boolean).join('/')}`;

  // Percent-encoding is rejected rather than decoded: `%2e%2e` and `%2f` are how
  // an exact-match allowlist gets bypassed, and no legitimate route here needs
  // an encoded character in its PATH.
  if (collapsed.includes('%')) return false;

  return PUBLIC_FEED_ROUTES.includes(collapsed);
}

/**
 * The Next.js `rewrites()` entries for the allowlisted routes.
 *
 * One rewrite per route, each an exact source. No `:path*` wildcard appears
 * anywhere, which is what makes "unlisted means unreachable" true rather than
 * aspirational.
 *
 * @param {string} feedOrigin e.g. `http://127.0.0.1:4600`
 */
export function feedRewrites(feedOrigin) {
  return PUBLIC_FEED_ROUTES.map((route) => ({
    source: `/feed${route}`,
    destination: `${feedOrigin}${route}`,
  }));
}
