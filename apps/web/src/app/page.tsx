import { LandingPage } from '@/components/landing/LandingPage';

export const metadata = {
  title: 'TradeW — An operating system for the way you trade',
  description:
    'One workspace for markets, research, risk and learning, with intelligence that explains what it sees. Observations only — never investment advice.',
};

/**
 * Root route — the marketing landing page, and the only page a signed-out
 * visitor can reach.
 *
 * Two decisions are recorded here because both were reversed:
 *
 * 1. This once redirected straight to `/dashboard`, on the reasoning that
 *    TradeW opens into a workspace rather than a broker marketing site. That
 *    still holds for people who are already users and is preserved exactly —
 *    the script below sends anyone holding a session to the workspace before
 *    this page paints. TRADEW-OS.md §1 permits the marketing surface itself,
 *    since "marketing reaches people who are not yet users".
 *
 * 2. The comment that used to live here also said there was "no login wall in
 *    front of the Phase-1 workspace, which runs on mock data". There is one
 *    now — see `middleware.ts`. The workspace is no longer reachable without
 *    an account, so the landing page is where everyone starts and sign-in
 *    happens in its `#auth` section rather than on a separate page.
 *
 * `/` is already in nav-config's BARE_ROUTES, so AppFrame renders this without
 * the Sidebar/TopBar/Ticker chrome — no shell changes were needed.
 *
 * The redirect runs as a pre-paint inline script rather than a client effect
 * for the same reason layout.tsx's THEME_INIT_SCRIPT does: an effect would
 * flash the marketing page at a signed-in user before React could redirect.
 * Static string, no interpolated data, so inlining is safe.
 */
/**
 * ── THE REDIRECT LOOP THIS SCRIPT USED TO CAUSE (fixed 2026-08-11) ─────────
 *
 * This previously read `if (localStorage.getItem('tradew_token')) redirect`.
 * `middleware.ts` gates the workspace on the `tw_auth` COOKIE. Two components,
 * two different definitions of "signed in", and they can disagree — the
 * localStorage token outlives the cookie whenever the cookie is cleared,
 * expires, or is dropped by the browser while localStorage survives.
 *
 * When they disagreed the app hung in an infinite loop:
 *
 *   /dashboard → middleware sees no cookie → /?next=%2Fdashboard#auth
 *              → this script sees a token  → /dashboard
 *              → middleware sees no cookie → … forever
 *
 * The browser shows a blank page with the tab title set and a spinner that
 * never stops, then ERR_TOO_MANY_REDIRECTS. Reproduced at 27 navigations.
 * It surfaced most often "when starting the web server", because that is
 * exactly when a cookie gets dropped while localStorage does not.
 *
 * ── THE FIX: ONE DEFINITION OF SIGNED IN ──────────────────────────────────
 *
 * Redirect only when BOTH the token and the cookie are present, because the
 * cookie is what the middleware will actually check — a token without one
 * cannot get through, so following it is guaranteed to bounce.
 *
 * And when the token is there without the cookie, it is stale: clear it, so
 * `lib/api.ts` stops sending a bearer that will only 401, and the visitor gets
 * the sign-in form instead of a loop. Note the redirect is NOT re-armed after
 * clearing — this render stays on the landing page by design.
 *
 * Two independent guards, either of which alone breaks the loop. That is
 * deliberate: this failure mode is invisible in every automated check that
 * does not use a real browser, so it gets belt and braces.
 */
/**
 * Reads THIS TAB's session first (sessionStorage), falling back to the
 * device's most recent one (localStorage) only for a tab that has never held a
 * session — the same precedence `lib/session-storage.ts` implements for the
 * app proper, restated here because a pre-paint script cannot import.
 *
 * Without the sessionStorage read, a tab signed in as user2 whose device
 * mirror had been retargeted to user3 would be bounced through the landing
 * page and re-adopt user3 — reintroducing the cross-tab bug from the one place
 * that runs before any of the fixed code does.
 */
const SESSION_REDIRECT_SCRIPT = `(function(){try{
var t=sessionStorage.getItem('tradew_token');
if(!t&&!sessionStorage.getItem('tradew_tab_claimed')){t=localStorage.getItem('tradew_token');}
var c=document.cookie.indexOf('tw_auth=')!==-1;
if(t&&!c){sessionStorage.removeItem('tradew_token');sessionStorage.removeItem('tradew_refresh_token');localStorage.removeItem('tradew_token');localStorage.removeItem('tradew_refresh_token');return;}
if(t&&c&&location.search.indexOf('next=')===-1){location.replace('/dashboard');}
}catch(e){}})();`;

export default function Home() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SESSION_REDIRECT_SCRIPT }} />
      <LandingPage />
    </>
  );
}
