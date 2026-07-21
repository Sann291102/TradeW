import type { ComponentType, SVGProps } from 'react';
import { NAV_ITEMS } from '@/components/shell/nav-config';
import {
  MarketsIcon,
  SettingsIcon,
  LearningIcon,
  PortfolioIcon,
  ResearchIcon,
  SentinelIcon,
  KnowledgeIcon,
  SparkleIcon,
  SunIcon,
  MoonIcon,
  ContrastIcon,
  MenuIcon,
  BellIcon,
  LayoutIcon,
  PlusIcon,
} from '@/components/shell/icons';
import { INDEX_QUOTES, TICKER_EXTRA, WATCHLIST, TOP_GAINERS, TOP_LOSERS } from '@/lib/mock/market';
import { FO_STOCK_UNIVERSE } from '@/lib/mock/foUniverse';
import { ALL_NSE_INDICES } from '@/lib/mock/indices';
import { LEARNING_CATEGORIES, LEARNING_PATHS } from '@/lib/mock/learning';
import type { SearchContext, SearchProvider, SearchResult } from './types';

function matches(query: string, ...haystack: string[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return haystack.some((h) => h.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Navigation — every workspace page (nav-config is the single source, so
// adding a page to the sidebar automatically makes it searchable).
// ---------------------------------------------------------------------------
const navigationProvider: SearchProvider = {
  id: 'navigation',
  label: 'Go to',
  search: (query, ctx) =>
    NAV_ITEMS.filter((item) => matches(query, item.label))
      .slice(0, 8)
      .map((item) => ({
        id: `nav-${item.href}`,
        title: item.label,
        subtitle: item.href,
        icon: item.icon,
        action: () => ctx.navigate(item.href),
      })),
};

// ---------------------------------------------------------------------------
// Stocks & indices — deduplicated by symbol/name. `FO_STOCK_UNIVERSE` (every
// NSE F&O-eligible stock) and `ALL_NSE_INDICES` (every NSE index) make the
// full real symbol universe searchable, not just the ~15 hand-picked
// mock-priced entries — see lib/mock/foUniverse.ts and lib/mock/indices.ts.
// ---------------------------------------------------------------------------
const ALL_SYMBOLS = (() => {
  const map = new Map<string, string>();
  for (const q of [...INDEX_QUOTES, ...TICKER_EXTRA]) map.set(q.symbol, q.name);
  for (const w of WATCHLIST) map.set(w.symbol, w.name);
  for (const m of [...TOP_GAINERS, ...TOP_LOSERS]) map.set(m.symbol, m.name);
  for (const s of FO_STOCK_UNIVERSE) map.set(s.symbol, s.name);
  for (const idx of ALL_NSE_INDICES) if (!map.has(idx.name)) map.set(idx.name, idx.name);
  return Array.from(map.entries()).map(([symbol, name]) => ({ symbol, name }));
})();

const stockProvider: SearchProvider = {
  id: 'stocks',
  label: 'Stocks & indices',
  search: (query, ctx) => {
    if (!query) return [];
    return ALL_SYMBOLS.filter((s) => matches(query, s.symbol, s.name))
      .slice(0, 6)
      .map((s) => ({
        id: `sym-${s.symbol}`,
        title: s.symbol,
        subtitle: s.name,
        icon: MarketsIcon,
        action: () => {
          ctx.setSelectedSymbol(s.symbol);
          ctx.navigate('/trade');
        },
      }));
  },
};

// ---------------------------------------------------------------------------
// Learning topics
// ---------------------------------------------------------------------------
const learningProvider: SearchProvider = {
  id: 'learning',
  label: 'Learning',
  search: (query, ctx) => {
    const cats = LEARNING_CATEGORIES.filter((c) => matches(query, c.name));
    const paths = query ? LEARNING_PATHS.filter((p) => matches(query, p.name)) : [];
    const results: SearchResult[] = [
      ...paths.map((p) => ({
        id: `learn-path-${p.name}`,
        title: p.name,
        subtitle: 'Learning path',
        icon: LearningIcon,
        action: () => ctx.navigate('/learning'),
      })),
      ...cats.map((c) => ({
        id: `learn-cat-${c.name}`,
        title: c.name,
        subtitle: `${c.lessons} lessons · ${c.tier}`,
        icon: LearningIcon,
        action: () => ctx.navigate('/learning'),
      })),
    ];
    return results.slice(0, 6);
  },
};

// ---------------------------------------------------------------------------
// Commands — workspace actions (theme, sidebar, notifications, layout, tabs).
// ---------------------------------------------------------------------------
const commandsProvider: SearchProvider = {
  id: 'commands',
  label: 'Commands',
  search: (query, ctx) => {
    const all: SearchResult[] = [
      { id: 'cmd-theme-dark', title: 'Theme: Dark', icon: MoonIcon, action: () => ctx.setTheme('dark') },
      { id: 'cmd-theme-light', title: 'Theme: Light', icon: SunIcon, action: () => ctx.setTheme('light') },
      { id: 'cmd-theme-hc', title: 'Theme: High Contrast', icon: ContrastIcon, action: () => ctx.setTheme('high-contrast') },
      { id: 'cmd-sidebar', title: 'Toggle sidebar', subtitle: 'Ctrl/⌘ + B', icon: MenuIcon, action: ctx.toggleSidebar },
      { id: 'cmd-notifications', title: 'Open notifications', icon: BellIcon, action: ctx.openNotifications },
      { id: 'cmd-shortcuts', title: 'Keyboard shortcuts', subtitle: 'Ctrl/⌘ + /', icon: SettingsIcon, action: ctx.openShortcutsHelp },
      { id: 'cmd-reset-layout', title: 'Reset workspace layout', icon: LayoutIcon, action: ctx.resetLayout },
      { id: 'cmd-new-tab', title: 'New workspace tab', icon: PlusIcon, action: ctx.newWorkspaceTab },
      { id: 'cmd-upgrade', title: 'Sentinel plans & pricing', icon: SentinelIcon, action: () => ctx.navigate('/settings') },
    ];
    return all.filter((c) => matches(query, c.title, c.subtitle ?? ''));
  },
};

// ---------------------------------------------------------------------------
// Stub providers (§6: "prepare modular providers, backend search can come
// later"). Each surfaces one disabled "coming soon" row, and only when the
// query plausibly targets that domain — real backend search replaces the
// `search()` body without touching the provider's shape or the palette UI.
// ---------------------------------------------------------------------------
function stubProvider(
  id: string,
  label: string,
  icon: ComponentType<SVGProps<SVGSVGElement>>,
  keywords: string[],
): SearchProvider {
  return {
    id,
    label,
    search: (query) => {
      if (!query || !matches(query, ...keywords)) return [];
      return [
        {
          id: `${id}-stub`,
          title: `Search ${label.toLowerCase()} — coming soon`,
          subtitle: 'Backend search lands in a later milestone',
          icon,
          disabled: true,
        },
      ];
    },
  };
}

export const SEARCH_PROVIDERS: SearchProvider[] = [
  navigationProvider,
  stockProvider,
  learningProvider,
  commandsProvider,
  stubProvider('portfolio', 'Portfolio', PortfolioIcon, ['portfolio', 'holdings', 'position']),
  stubProvider('research', 'Research', ResearchIcon, ['research', 'fundamentals', 'company']),
  stubProvider('sentinel', 'Sentinel', SentinelIcon, ['sentinel', 'observation', 'risk']),
  stubProvider('knowledge', 'Knowledge', KnowledgeIcon, ['knowledge', 'graph', 'concept']),
  stubProvider('tradew-ai', 'TradeW AI', SparkleIcon, ['ai', 'assistant', 'chat', 'ask']),
];

export function runSearch(query: string, ctx: SearchContext): Array<{ provider: SearchProvider; results: SearchResult[] }> {
  return SEARCH_PROVIDERS.map((provider) => ({ provider, results: provider.search(query.trim(), ctx) })).filter(
    (g) => g.results.length > 0,
  );
}
