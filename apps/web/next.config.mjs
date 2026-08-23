/** @type {import('next').NextConfig} */

import { feedRewrites } from './feed-proxy-routes.mjs';

/**
 * Same-origin proxying for the API and the Dhan feed.
 *
 * The browser talks only to the web origin: `/api/*` and the allowlisted
 * `/feed/*` routes are forwarded server-side to services/api and the live-feed
 * bridge. Three consequences, all of them wanted:
 *
 *  · ONE public URL. Sharing the app over a tunnel previously needed three
 *    (web, api, bridge) because the browser addressed each directly. With a
 *    single static domain that is impossible; behind this proxy it is one.
 *  · No CORS. Every request is same-origin, so FRONTEND_URL no longer has to
 *    list whatever hostname the tunnel handed out this time.
 *  · The bridge stops being publicly addressable on its own.
 *
 * This mirrors production, where Caddy does the same routing and the web image
 * is built with NEXT_PUBLIC_API_URL=/api (see .github/workflows/deploy.yml).
 * Targets stay overridable so a non-default local port still works.
 *
 * ── FEED PROXY: ALLOWLIST, NOT WILDCARD ────────────────────────────────────
 *
 * `/feed/:path*` used to forward every route the bridge exposes — and every route
 * it would ever gain. The bridge has no authentication of its own, so that made
 * "publicly reachable" the default for anything added to it. The proxy now
 * forwards an explicit list of read-only public market-data routes and nothing
 * else; see feed-proxy-routes.mjs for the list and the rule for adding to it.
 * Anything user-scoped belongs behind services/api's AuthGuard, not here.
 */
const API_ORIGIN = process.env.API_PROXY_TARGET || 'http://127.0.0.1:4000';
const FEED_ORIGIN = process.env.FEED_PROXY_TARGET || 'http://127.0.0.1:4600';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Origins the browser is permitted to open connections to.
 *
 * Behind the proxy everything is same-origin, so `'self'` covers the normal
 * case. The extra entries exist because both targets remain directly addressable
 * in development (and `NEXT_PUBLIC_*` may point at them), and a CSP that breaks
 * local development gets deleted rather than fixed.
 */
const connectSources = [
  "'self'",
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NEXT_PUBLIC_DHAN_LIVE_URL,
  process.env.NEXT_PUBLIC_SENTINEL_URL,
  // WebSocket for the live tick stream.
  'ws:',
  'wss:',
  ...(isProd ? [] : ['http://localhost:*', 'http://127.0.0.1:*']),
]
  .filter(Boolean)
  // A configured value may be a path (`/api`) rather than an origin; CSP only
  // accepts hosts, so path-only values are dropped as already covered by 'self'.
  .filter((s) => !s.startsWith('/'))
  .join(' ');

/**
 * Content-Security-Policy.
 *
 * Honest about its limits: `script-src` includes `'unsafe-inline'` because Next's
 * App Router injects inline bootstrap and streaming-payload scripts, and
 * `'unsafe-eval'` in development for React Refresh. Nonce-based CSP requires
 * moving every page onto middleware-generated nonces, which is a larger change
 * than a hardening pass should make silently — so this policy is written to be
 * genuinely enforced rather than to look strict and be disabled on first
 * regression. What it does buy, even with unsafe-inline:
 *
 *  · `default-src 'self'` — no loading from arbitrary third-party origins.
 *  · `object-src 'none'` — kills Flash/PDF-plugin script vectors.
 *  · `base-uri 'self'` — stops a `<base>` injection repointing relative URLs.
 *  · `form-action 'self'` — an injected form cannot POST credentials offsite.
 *  · `frame-ancestors 'none'` — clickjacking, the CSP counterpart to
 *    X-Frame-Options (and the one modern browsers actually honour).
 *  · `upgrade-insecure-requests` in production.
 *
 * Tightening `script-src` to nonces is worth doing and is not done here.
 */
// Razorpay Checkout (services/api/src/payments). The widget is an external
// script that opens payment frames and phones home to *.razorpay.com. These
// origins are only ever contacted once a signed-in user opens checkout with
// billing enabled; listing them here does not weaken the default-deny posture
// for every other route. Kept as a named constant so the payment surface's CSP
// footprint is auditable in one place rather than smeared across directives.
const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com';
const RAZORPAY_FRAME = 'https://api.razorpay.com https://checkout.razorpay.com';
const RAZORPAY_CONNECT = 'https://*.razorpay.com https://lumberjack.razorpay.com';

// TradingView Advanced Chart widget (components/charts/TradingViewWidget.tsx),
// used by the Markets workspace for the crypto and FX venues. The loader script
// comes from s3.tradingview.com and injects an iframe served from
// tradingview-widget.com; both origins are required or the embed renders an
// empty box with a console CSP violation and no other symptom.
//
// Scoped deliberately: this is a THIRD-PARTY FRAME on a trading surface, so it
// gets frame-src and script-src and nothing else. It is not added to
// connect-src — the widget talks to TradingView from inside its own iframe,
// which is that frame's origin, not this one. Nothing on our side fetches from
// TradingView, and no TradingView script may open a connection from our page.
//
// Same named-constant treatment as Razorpay above, for the same reason: the
// external-origin footprint stays auditable in one place.
const TRADINGVIEW_SCRIPT = 'https://s3.tradingview.com';
const TRADINGVIEW_FRAME = 'https://www.tradingview-widget.com https://s.tradingview.com https://www.tradingview.com';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${RAZORPAY_SCRIPT} ${TRADINGVIEW_SCRIPT}${isProd ? '' : " 'unsafe-eval'"}`,
  // Tailwind and the design system inject style tags; inline styles are not a
  // script-execution vector.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${connectSources} ${RAZORPAY_CONNECT}`,
  `frame-src 'self' ${RAZORPAY_FRAME} ${TRADINGVIEW_FRAME}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

/**
 * Security response headers.
 *
 * Set here rather than via a dependency: Next serves these on every route
 * including static assets, and adding a middleware package for six static
 * headers is more moving parts than the headers themselves.
 */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Defence in depth alongside `frame-ancestors 'none'` — still honoured by
  // older browsers that ignore the CSP directive.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Stops MIME sniffing turning an uploaded or proxied response into script.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Send the origin cross-site, the full URL same-site. Trading URLs carry
  // instrument, strike and expiry parameters that should not leak to third
  // parties in a Referer header.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Deny the device APIs this application has no use for, so an injected script
  // cannot silently request them.
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()',
  },
  // Keeps this origin out of other pages' process, blunting cross-origin
  // side-channel reads.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/**
 * HSTS is production-only, deliberately.
 *
 * On localhost there is no certificate, and a browser that has pinned
 * `Strict-Transport-Security` for `localhost` will refuse plain HTTP for every
 * other project on the machine for the next two years. `includeSubDomains` and
 * `preload` are set because the deployed app is a single domain served entirely
 * over TLS by Caddy.
 */
if (isProd) {
  securityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  });
}

const nextConfig = {
  // Consume the shared design-system package directly from TS source — no
  // separate build step for @tradew/ui (ARCHITECTURE.md packages/ui).
  transpilePackages: ['@tradew/ui'],

  // Do not advertise the framework version to scanners.
  poweredByHeader: false,

  allowedDevOrigins: ['*.trycloudflare.com'],

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },

  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/:path*` },
      // Explicit, exact routes only. No wildcard — see feed-proxy-routes.mjs.
      ...feedRewrites(FEED_ORIGIN),
    ];
  },
};
export default nextConfig;
