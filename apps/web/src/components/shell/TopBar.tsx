'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { cn, IconButton, Badge } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useSessionStore } from '@/lib/store/sessionStore';
import { initials } from '@/lib/format';
import { NAV_ITEMS } from './nav-config';
import { ThemeMenu } from './ThemeMenu';
import { MenuIcon, SearchIcon, BellIcon, SparkleIcon, SentinelIcon, CommandIcon } from './icons';

function pageTitle(pathname: string): string {
  const match = NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(i.href + '/'));
  return match?.label ?? 'TradeW';
}

/** Paper/Live toggle — Live is entitlement/broker-gated; M2 renders the control,
 *  Paper is the only enabled mode (no live broker in paper product). */
function PaperLiveToggle() {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  return (
    <div
      role="group"
      aria-label="Trading mode"
      className="flex items-center rounded-lg border border-border2 p-0.5 text-xs font-bold"
    >
      <button
        type="button"
        aria-pressed={mode === 'paper'}
        onClick={() => setMode('paper')}
        className={cn(
          'rounded-md px-2.5 py-1 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          mode === 'paper' ? 'bg-amber-bg text-amber' : 'text-muted hover:text-text',
        )}
      >
        PAPER
      </button>
      <button
        type="button"
        aria-pressed={mode === 'live'}
        onClick={() => setMode('live')}
        title="Live trading requires a funded broker account"
        className={cn(
          'rounded-md px-2.5 py-1 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          mode === 'live' ? 'bg-up-bg text-up' : 'text-faint hover:text-muted',
        )}
      >
        LIVE
      </button>
    </div>
  );
}

/** Market status pill — session state dot + label (mirrors the canonical #mktPill). */
function MarketStatus() {
  return (
    <div className="hidden items-center gap-2 rounded-full bg-hover px-3 py-1.5 text-xs text-muted sm:flex">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-up opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-up" />
      </span>
      <span>Market open</span>
      <span className="text-faint">· NSE</span>
    </div>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const setMobileNavOpen = useWorkspaceStore((s) => s.setMobileNavOpen);
  const setAiDockOpen = useWorkspaceStore((s) => s.setAiDockOpen);
  const setCommandPaletteOpen = useWorkspaceStore((s) => s.setCommandPaletteOpen);
  const setNotificationCenterOpen = useWorkspaceStore((s) => s.setNotificationCenterOpen);
  const unread = useWorkspaceStore((s) => s.unreadCount());
  const sessionUser = useSessionStore((s) => s.user);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-3 sm:px-4">
      {/* mobile menu */}
      <IconButton aria-label="Open navigation" className="lg:hidden" onClick={() => setMobileNavOpen(true)}>
        <MenuIcon />
      </IconButton>

      <h1 className="text-sm font-bold text-text">{pageTitle(pathname)}</h1>
      <MarketStatus />

      {/* search — a trigger for the command palette (Ctrl/⌘+Shift+F focuses it,
          Ctrl/⌘+K opens it directly), not a live-typing field itself: rendered as
          a button styled like a search input so focus/activation behavior is
          honest to both mouse and screen-reader users. */}
      <button
        type="button"
        id="topbar-search"
        onClick={() => setCommandPaletteOpen(true)}
        aria-label="Search stocks, indices, F&O — opens the command palette"
        className="relative ml-auto hidden max-w-sm flex-1 items-center rounded-lg border border-border2 bg-bg py-2 pl-9 pr-12 text-left text-sm text-faint transition-colors duration-micro hover:border-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:flex"
      >
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        Search stocks, indices, F&amp;O…
        <kbd className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded border border-border2 px-1.5 py-0.5 text-[10px] font-semibold text-faint">
          <CommandIcon className="h-2.5 w-2.5" />K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5 md:ml-0">
        <PaperLiveToggle />

        {/* Placeholder entrypoints (Step 3): TradeW AI, Sentinel, Subscriptions.
            Visually present; wired in later milestones. */}
        <IconButton aria-label="Ask TradeW AI" onClick={() => setAiDockOpen(true)} className="text-teal">
          <SparkleIcon />
        </IconButton>
        <Link
          href="/sentinel"
          aria-label="Open Sentinel"
          className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:inline-flex"
        >
          <SentinelIcon />
        </Link>
        <Link
          href="/settings"
          className="hidden items-center rounded-lg border border-teal px-2.5 py-1.5 text-xs font-bold text-teal transition-colors duration-micro hover:bg-teal hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:inline-flex"
        >
          Upgrade
        </Link>

        <ThemeMenu />

        <IconButton aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`} onClick={() => setNotificationCenterOpen(true)}>
          <BellIcon />
          {unread > 0 && (
            <Badge tone="negative" className="absolute -right-1 -top-1 min-w-[16px] justify-center px-1 py-0 text-[9px]">
              {unread}
            </Badge>
          )}
        </IconButton>
        <Link
          href={sessionUser ? '/profile' : '/login'}
          aria-label={sessionUser ? `Profile — ${sessionUser.email}` : 'Sign in'}
          title={sessionUser?.email}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            sessionUser ? 'bg-teal text-white' : 'border border-dashed border-border2 text-faint',
          )}
        >
          {sessionUser ? initials(sessionUser.email) : '?'}
        </Link>
      </div>
    </header>
  );
}
