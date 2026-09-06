import type { ComponentType, SVGProps } from 'react';
import {
  HomeIcon,
  TradeIcon,
  MarketsIcon,
  PortfolioIcon,
  LearningIcon,
  SentinelIcon,
  SettingsIcon,
  ProfileIcon,
  ResearchIcon,
  NewsIcon,
  OrdersIcon,
  PositionsIcon,
  BacktestingIcon,
  ReportsIcon,
  AlertsIcon,
  CalendarIcon,
  CommunityIcon,
} from './icons';

export interface NavItem {
  /** Route href. */
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Premium surface — shows a lock/upgrade affordance until entitled (SUBSCRIPTIONS.md §4). */
  premium?: boolean;
  /** Built but not finished. Stays navigable — the route works and shows real
   *  data — while the badge sets the expectation that it is not complete. */
  comingSoon?: boolean;
  /** Grouping for the sidebar (primary rail vs. secondary/footer). */
  group: 'primary' | 'secondary';
}

/**
 * Sidebar navigation is DRIVEN BY THIS CONFIG (Milestone 2, Step 2) — pages are
 * never hardcoded in the Sidebar component. Adding a workspace = adding a row
 * here. Order and grouping are the navigation contract; the icon rail renders
 * exactly this list.
 *
 * Items map to real routes: some already exist (trade, sentinel, profile),
 * some are new in M2 (dashboard, markets, portfolio, learning, settings).
 * Sentinel is `premium` — always visible, gated at use (the brief's "users
 * always see Sentinel").
 *
 * This config governs the PUBLIC workspace only. The admin portal at /admin is
 * deliberately absent from it and from every other public surface: it has its
 * own shell, its own nav, and is reachable only by typing the URL while holding
 * a session that passes the server-side admin check.
 */
export const NAV_ITEMS: NavItem[] = [
  // ── PRIMARY: the canonical TradeW product areas, in the canonical order ──
  //
  // "Home" is a LABEL, not a new page. The route is still `/dashboard` and the
  // component behind it is the same Market Workspace it always was — see
  // `app/(workspace)/home/page.tsx`, which is a redirect to it, not a second
  // implementation. Renaming the route would have broken the post-sign-in
  // redirect, the error page's escape hatch, the assistant's route list and a
  // test that asserts the exact string; renaming the label broke nothing.
  { href: '/dashboard', label: 'Home', icon: HomeIcon, group: 'primary' },
  { href: '/markets', label: 'Markets', icon: MarketsIcon, group: 'primary' },
  // The CATALOGUE, beside the live board. Markets answers "what is it worth
  // right now" for a handful of instruments; Universe answers "what exists, on
  // which venue, in which currency" for all ~10^5 of them. Same icon family,
  // deliberately adjacent, but a separate route because the two have opposite
  // data shapes — one polls a few rows, the other paginates a great many.
  { href: '/universe', label: 'Universe', icon: MarketsIcon, group: 'primary' },
  { href: '/portfolio', label: 'Portfolio', icon: PortfolioIcon, group: 'primary' },
  { href: '/trade', label: 'Trade', icon: TradeIcon, group: 'primary' },
  // Orders and Positions are the Portfolio workspace's own sections, promoted
  // to top-level entries because that is where traders look for them. Both
  // routes render the SAME PortfolioClient with a different opening section —
  // there is no second orders table and no second positions calculation. See
  // app/(workspace)/orders/page.tsx.
  { href: '/orders', label: 'Orders', icon: OrdersIcon, group: 'primary' },
  { href: '/positions', label: 'Positions', icon: PositionsIcon, group: 'primary' },
  // Named "AI Sentinel" here; the route, the service and every internal symbol
  // stay `sentinel`. Deliberately NOT a Watchlist: TradeW has no watchlist
  // feature, and inventing one to fill a slot would be a lie in the nav.
  { href: '/sentinel', label: 'AI Sentinel', icon: SentinelIcon, premium: true, group: 'primary' },
  { href: '/learning', label: 'Learning', icon: LearningIcon, group: 'primary' },
  // Badged SOON and honest about it: there is no backtesting engine in this
  // repository — no strategy runner, no historical simulation, nothing behind
  // `/backtesting` but a page that says so and points at what does exist.
  { href: '/backtesting', label: 'Backtesting', icon: BacktestingIcon, comingSoon: true, group: 'primary' },
  // Research is the existing /research workspace, unchanged. There is no
  // separate "Analytics" page in apps/web to rename — `services/analytics` and
  // `lib/analytics.ts` are a telemetry service and a click logger, neither of
  // them a user-facing surface, and both keep their names.
  { href: '/research', label: 'Research', icon: ResearchIcon, group: 'primary' },
  { href: '/news', label: 'News Feed', icon: NewsIcon, group: 'primary' },
  // Reports has no backend. The page lists what CAN be exported today and
  // links to it, rather than rendering a report catalogue that would 404.
  { href: '/reports', label: 'Reports', icon: ReportsIcon, comingSoon: true, group: 'primary' },
  // Alerts is the real notification feed (`GET /notifications`) under the name
  // traders use for it. `/alerts` redirects here so both names work.
  { href: '/notifications', label: 'Alerts', icon: AlertsIcon, group: 'primary' },
  // Real NSE corporate-event data (`GET /nse/events`) plus the live segment
  // status. Not a personal calendar — there is no store for user reminders,
  // and the page says so instead of offering an "add event" that drops input.
  { href: '/calendar', label: 'Calendar', icon: CalendarIcon, group: 'primary' },
  // New product area. No community backend exists, so the page is an honest
  // empty state describing what it will be — no seeded posts, no fake members.
  { href: '/community', label: 'Community', icon: CommunityIcon, comingSoon: true, group: 'primary' },
  { href: '/settings', label: 'Settings', icon: SettingsIcon, group: 'primary' },

  // ── SECONDARY ────────────────────────────────────────────────────────────
  //
  // Crypto and Forex used to sit here. The comment that put them here said it
  // outright — "they are venues, which is why they sit next to each other
  // under Markets' concern" — and that reasoning has now been followed the
  // rest of the way: a venue belongs INSIDE Markets, next to Indices and
  // Commodities, not as two more entries in the product-area rail.
  //
  // They are still real, working surfaces (Binance / Twelve Data, see
  // services/api/src/crypto) and nothing was hidden. Both are tabs on
  // /markets, reached with the ₹/$ currency switch, and /crypto and /forex
  // redirect there so every existing link and bookmark still resolves.
  //
  // Profile is reachable from Settings -> Account as well; kept here because
  // it is where the sign-out button lives.
  { href: '/profile', label: 'Profile', icon: ProfileIcon, group: 'secondary' },
];

/**
 * User-facing renames that must not break an existing URL.
 *
 * Each entry is served by a tiny route file that redirects — see
 * `app/(workspace)/home` and `app/(workspace)/alerts`. Listed here so the set
 * is visible in one place rather than discovered by grepping the route tree.
 *
 *   /home   -> /dashboard              "Dashboard" is now labelled "Home"
 *   /alerts -> /notifications          "Notifications" is now labelled "Alerts"
 *   /crypto -> /markets?cat=crypto     Crypto is a Markets venue, not a page
 *   /forex  -> /markets?cat=forex      Forex is a Markets venue, not a page
 *
 * The last two carry a query string, which is why they redirect rather than
 * simply being renamed: the destination is a tab within Markets, and `?cat=`
 * is what selects it (see CATEGORY_BY_PARAM in MarketsWorkspace).
 */
export const NAV_ALIASES: Record<string, string> = {
  '/home': '/dashboard',
  '/alerts': '/notifications',
  '/crypto': '/markets?cat=crypto',
  '/forex': '/markets?cat=forex',
};

/** Routes that must NOT get the workspace chrome (auth / marketing). */
export const BARE_ROUTES = ['/', '/login', '/signup'];

export function isBareRoute(pathname: string): boolean {
  return BARE_ROUTES.includes(pathname);
}

/**
 * Routes that render their own dedicated shell instead of the shared
 * Sidebar/TopBar/Ticker/FloatingAI chrome. Reverted for `/sentinel` on
 * 2026-07-21 — a first pass removed all chrome there (see archive/README.md
 * for `SentinelShell.tsx`), but that left no way to navigate back out to the
 * rest of the app, a dead end rather than "standalone." The Sidebar/TopBar
 * now wrap `/sentinel` like every other route; the redesigned page content
 * (Day Classification / Market Context / Live Safety Feed) is unaffected.
 * Left this mechanism in place, empty, in case a real standalone-shell need
 * comes up again.
 */
// Admin has been migrated to apps/admin (port 3001) — a fully separate Next.js
// app with its own server, session cookie, and no dependency on the web shell.
// STANDALONE_ROUTES is kept for any future routes that need to opt out of the
// trader chrome without being a full separate app.
export const STANDALONE_ROUTES: string[] = [];

export function isStandaloneRoute(pathname: string): boolean {
  return STANDALONE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'));
}
