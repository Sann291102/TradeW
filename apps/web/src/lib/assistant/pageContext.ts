'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';

/**
 * What the user is looking at, sent with every analysis request
 * (`TRADEW-ASSISTANT.md` §4, `AI-CONVERSATION-LIFECYCLE.md` §5).
 *
 * This is what makes "explain this" mean something. Without it the assistant
 * has to ask "explain what?", which is exactly the interaction the feature
 * exists to remove.
 *
 * Derived, never stored: the doc is explicit that only the conversation
 * persists and page context is recomputed from the restored route
 * (`WORKSPACE-CONTINUITY.md` §2). Storing it would create a second, staler
 * copy of state the workspace already owns.
 */

export interface PageContext {
  route?: string;
  symbol?: string;
  timeframe?: string;
  indicators?: string[];
  panel?: string;
}

/** Human-readable names for routes, so the assistant can say where you are. */
const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/trade': 'Trading',
  '/markets': 'Markets',
  '/portfolio': 'Portfolio',
  '/research': 'Research',
  '/news': 'News',
  '/learning': 'Learning',
  '/sentinel': 'Sentinel',
  '/discipline': 'Discipline',
  '/crypto': 'Crypto',
  '/forex': 'Forex',
  '/settings': 'Settings',
};

export function routeLabel(pathname: string | null): string | undefined {
  if (!pathname) return undefined;
  const match = Object.keys(ROUTE_LABELS).find((r) => pathname.startsWith(r));
  return match ? ROUTE_LABELS[match] : undefined;
}

/**
 * Assemble the current page context.
 *
 * Only fields that are genuinely known are included — an absent field is
 * better than a guessed one, because the server folds this straight into a
 * model prompt and a wrong symbol produces a confidently wrong answer about
 * the wrong instrument.
 */
export function usePageContext(): PageContext {
  const pathname = usePathname();
  // The symbol lives on the ACTIVE TAB, not the store root — each workspace tab
  // has its own. Selecting the primitive keeps this from re-rendering the dock
  // on unrelated workspace changes.
  const selectedSymbol = useWorkspaceStore(
    (s) => s.workspaceTabs.find((t) => t.id === s.activeTabId)?.selectedSymbol,
  );

  return useMemo(() => {
    const ctx: PageContext = {};
    if (pathname) ctx.route = pathname;
    // The symbol is only meaningful on surfaces that actually show one. On
    // Settings or Learning it is a stale leftover from the last chart, and
    // sending it would make "explain this" answer about an instrument the
    // user cannot see.
    if (selectedSymbol && isSymbolBearingRoute(pathname)) ctx.symbol = selectedSymbol;
    const label = routeLabel(pathname);
    if (label) ctx.panel = label;
    return ctx;
  }, [pathname, selectedSymbol]);
}

const SYMBOL_ROUTES = ['/trade', '/markets', '/research', '/dashboard', '/crypto', '/forex'];

export function isSymbolBearingRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return SYMBOL_ROUTES.some((r) => pathname.startsWith(r));
}
