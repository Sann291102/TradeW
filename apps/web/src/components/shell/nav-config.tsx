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
  BellIcon,
  ResearchIcon,
  CryptoIcon,
  ForexIcon,
  NewsIcon,
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
  { href: '/dashboard', label: 'Dashboard', icon: HomeIcon, group: 'primary' },
  { href: '/trade', label: 'Trade', icon: TradeIcon, group: 'primary' },
  { href: '/markets', label: 'Markets', icon: MarketsIcon, group: 'primary' },
  // Global markets, served by providers other than Dhan (Binance / Twelve
  // Data). Placed next to Markets because that is what they are — a different
  // venue, not a different kind of feature. Read-only: neither is placeable in
  // the rupee-denominated paper OMS, see services/api/src/crypto.
  { href: '/crypto', label: 'Crypto', icon: CryptoIcon, group: 'primary' },
  // Forex stays reachable and its data is real, but it is not a finished
  // surface: no charts, no order controls, and it cannot be traded (spot FX is
  // fractional and the OMS is rupee-denominated with Int quantities). Badged so
  // the gap is stated rather than discovered.
  { href: '/forex', label: 'Forex', icon: ForexIcon, comingSoon: true, group: 'primary' },
  // Moved off the dashboard, where it was capped at six items and competing
  // with the market widgets for space. Real newswires, not the former mock feed.
  { href: '/news', label: 'Market News', icon: NewsIcon, group: 'primary' },
  { href: '/portfolio', label: 'Portfolio', icon: PortfolioIcon, group: 'primary' },
  { href: '/research', label: 'Research', icon: ResearchIcon, group: 'primary' },
  { href: '/learning', label: 'Learning', icon: LearningIcon, group: 'primary' },
  // Knowledge was removed from this list on 2026-08-03 and now lives at
  // /admin/knowledge. It was never a trader-facing surface: the graph it
  // renders is the engineering vault (Decisions, Gotchas, Research notes) that
  // the agents write to, and exposing it on the public workspace put internal
  // architecture in front of every signed-in user. See apps/web/src/app/admin.
  //
  // SentinelIntelligence (citation-grounded multi-agent reasoning + the
  // 3-panel visual strategy workspace) was previously embedded inside this
  // page (SentinelIntelligencePanel) — removed 2026-08-05, archived to
  // archive/apps-web-sentinel-intelligence-2026-08-05/ (see archive/README.md).
  { href: '/sentinel', label: 'Sentinel', icon: SentinelIcon, premium: true, group: 'primary' },
  { href: '/settings', label: 'Settings', icon: SettingsIcon, group: 'secondary' },
  { href: '/profile', label: 'Profile', icon: ProfileIcon, group: 'secondary' },
  { href: '/notifications', label: 'Notifications', icon: BellIcon, group: 'secondary' },
];

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
