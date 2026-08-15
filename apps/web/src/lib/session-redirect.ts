/**
 * The landing page's pre-paint session decision, as a testable pure function.
 *
 * `app/page.tsx` inlines an equivalent implementation as a raw `<script>`,
 * because it must run BEFORE first paint (an effect would flash the marketing
 * page at a signed-in user) and therefore cannot import anything. That
 * duplication is deliberate but dangerous: an inline string is invisible to
 * the type-checker and to every test. So the logic lives here where it can be
 * asserted, and `session-redirect.test.ts` additionally checks that the inline
 * script still contains each guard — if someone edits the string and forgets
 * this file, the test fails.
 *
 * ── WHY THE GUARDS EXIST ──────────────────────────────────────────────────
 *
 * `middleware.ts` gates the workspace on the `tw_auth` cookie. This script used
 * to gate on the `tradew_token` in localStorage. Those two disagree whenever
 * the cookie is dropped and localStorage survives — which is exactly what a
 * browser or dev-server restart does — and the disagreement was an infinite
 * loop: middleware bounced /dashboard to /?next=%2Fdashboard, the script sent
 * it straight back, forever, ending in a blank page and ERR_TOO_MANY_REDIRECTS.
 */

export interface SessionState {
  /** localStorage `tradew_token` is present. */
  hasToken: boolean;
  /** The `tw_auth` cookie is present — what the middleware actually checks. */
  hasCookie: boolean;
  /** The URL carries `next=`, meaning the middleware just redirected us here. */
  cameFromMiddleware: boolean;
}

export type SessionDecision =
  /** Send them to the workspace. */
  | 'redirect'
  /** Token is stale: drop it and render the landing page. */
  | 'clear-stale-token'
  /** Do nothing. */
  | 'stay';

export function decideSessionRedirect(s: SessionState): SessionDecision {
  // A token without the cookie cannot pass the middleware, so following it is
  // guaranteed to bounce. Treat it as stale rather than chasing it.
  if (s.hasToken && !s.hasCookie) return 'clear-stale-token';

  // Second, independent loop-breaker: if the middleware just sent us here, do
  // not immediately send the browser back where it came from. Either guard
  // alone stops the loop; both are kept because this failure mode is invisible
  // to any check that is not a real browser.
  if (s.hasToken && s.hasCookie && !s.cameFromMiddleware) return 'redirect';

  return 'stay';
}
