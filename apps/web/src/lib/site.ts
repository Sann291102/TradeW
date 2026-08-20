/**
 * The application's public origin — if one is configured.
 *
 * TradeW has NO established canonical domain. Every `tradew.*` string in this
 * repository is a test fixture (`ops@tradew.io` in operator specs) or an
 * illustrative hostname inside a design document; deploy addresses its target
 * by an IP/secret and builds the web image with `NEXT_PUBLIC_API_URL=/api`.
 * See docs/footer/FOOTER_RESEARCH_REPORT.md §1.
 *
 * So this reads an env var and returns `null` when it is unset, and every
 * caller is written to do nothing in that case rather than fall back to a
 * plausible-looking host. A guessed canonical URL is worse than no canonical
 * URL: it tells crawlers the real pages live somewhere they do not.
 *
 * Set NEXT_PUBLIC_SITE_URL to the public origin (no trailing slash) once a
 * domain exists, and canonicals, `metadataBase` and the sitemap all start
 * working with no further code change.
 *
 * NOTE FOR DEPLOYMENT: `NEXT_PUBLIC_*` is inlined by Next at BUILD time, in
 * server code as well as client code. Setting this on a running container does
 * nothing — it has to be present when `next build` runs, which for this repo
 * means the Docker build arg alongside NEXT_PUBLIC_API_URL (see the Dockerfile
 * and .github/workflows/deploy.yml).
 */
export function siteUrl(): URL | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    // A malformed value is a configuration error, not a reason to crash the
    // render — behave exactly as if nothing were configured.
    return null;
  }
}

/**
 * Routes a signed-out visitor (and therefore a crawler) can actually reach.
 * Kept beside `siteUrl` because robots.ts and sitemap.ts both need it and must
 * not disagree. `/legal/*` entries are derived from the document set rather
 * than listed, so adding a legal document cannot leave it out of the sitemap.
 */
export const PUBLIC_CRAWLABLE_PATHS = ['/'];

/**
 * Everything a crawler must be kept out of.
 *
 * `middleware.ts` already redirects all of these to `/` for a signed-out
 * request, so this list is not the only defence — it states the intent, which
 * matters because "the auth wall happens to hide it" is a property that could
 * change without anyone thinking about search engines.
 *
 * `/reset` is here deliberately although it is public: it is a password-recovery
 * route reached from an email link, and there is no reason for it to be indexed.
 */
export const DISALLOWED_CRAWL_PATHS = [
  '/api/',
  '/auth/',
  '/reset',
  '/login',
  '/signup',
  '/dashboard',
  '/trade',
  '/markets',
  '/crypto',
  '/forex',
  '/news',
  '/portfolio',
  '/research',
  '/learning',
  '/sentinel',
  '/discipline',
  '/notifications',
  '/settings',
  '/profile',
  '/checkout',
];
