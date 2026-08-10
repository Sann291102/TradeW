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
const SESSION_REDIRECT_SCRIPT = `(function(){try{if(localStorage.getItem('tradew_token')){location.replace('/dashboard');}}catch(e){}})();`;

export default function Home() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SESSION_REDIRECT_SCRIPT }} />
      <LandingPage />
    </>
  );
}
