import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * The auth wall.
 *
 * A signed-out visitor can reach the landing page and the password-reset flow.
 * Everything else redirects to `/` — they read what TradeW is and create an
 * account before any part of the workspace is reachable.
 *
 * THIS SUPERSEDES the previous "no login wall in front of the Phase-1
 * workspace" decision recorded in `app/page.tsx`. That was written when the
 * workspace ran on mock data and letting people wander in cost nothing.
 * TRADEW-OS.md §1 still holds either way: it permits a marketing surface for
 * "people who are not yet users" and binds the one-workspace rule from
 * sign-in onward — it never required the workspace itself to be public.
 *
 * WHAT THIS IS AND IS NOT
 *
 * This is a ROUTING gate, not an authorization boundary. It reads `tw_auth`,
 * a valueless marker the client sets beside the real token (see lib/api.ts),
 * because middleware cannot read localStorage where the bearer token lives.
 * Anyone can forge that cookie and get an empty workspace shell whose every
 * API call 401s. The actual boundary is, and remains, `services/api` checking
 * the bearer token — one public ingress, per TRADEW-OS.md §2.2.
 *
 * So: do not add anything here that assumes the cookie proves identity.
 */

const AUTH_HINT_COOKIE = 'tw_auth';

/** Reachable signed out. Anything not matching redirects to the landing page. */
const PUBLIC_PATHS = new Set<string>([
  '/',
  // Password reset is reached from an email link by someone who by definition
  // cannot sign in. Gating it would lock out exactly the people it exists for.
  '/reset',
  // Where the Google round-trip lands to deposit its tokens. It runs before a
  // session exists, so it cannot require one.
  '/auth/callback',
  // Both now redirect to /#auth. Left public so they resolve to that redirect
  // rather than being bounced by this gate first, which would work but makes
  // the reason for the redirect harder to see in a network log.
  '/login',
  '/signup',
  // NOTE: `/sentinel/pricing` was briefly listed here (2026-08-15) when Sentinel
  // pricing was a public standalone route. It is no longer a route at all —
  // pricing is a view rendered by `/sentinel` for accounts without the
  // capability, so it is gated by this list's default-deny like everything else.
  // See archive/apps-web-sentinel-pricing-route-2026-08-15/.
]);

/**
 * The legal and trust surface — privacy notice, terms, cookie policy, risk
 * disclosure, disclaimer, security, responsible trading.
 *
 * A PREFIX rather than seven entries in the set above, because the routes are
 * generated from `lib/legal/documents.ts` and a second hand-maintained list is
 * a list that eventually disagrees with the first. `dynamicParams = false` on
 * the route means an unknown slug under this prefix 404s rather than reaching
 * anything, so the prefix does not widen the public surface beyond the
 * documents that exist.
 *
 * This has to be public, and the reason is not convenience: a privacy notice
 * that only an account holder can read is not a privacy notice, and a risk
 * disclosure a prospective user cannot reach before signing up is not a
 * disclosure. `lib/footer/links.test.ts` asserts every legal slug in the footer
 * matches this prefix, so an auth-gated legal page fails the build.
 */
const PUBLIC_PREFIXES = ['/legal/', '/feed/'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();
  if (req.cookies.get(AUTH_HINT_COOKIE)) return NextResponse.next();

  // Remember where they were headed so the app can restore it after sign-in.
  // `next` is a path on this origin only — it is validated on read, never
  // redirected to blindly, so this cannot become an open redirect.
  const url = req.nextUrl.clone();
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('next', pathname + search);
  url.hash = 'auth';
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * Everything except Next's own internals, the API & Feed proxy routes, and static
   * files. The negative lookahead is the documented Next pattern; the file
   * extension clause keeps images and fonts out of the gate so a signed-out
   * landing page can still load its own assets.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/|feed/|.*\\.[\\w]+$).*)'],
};
