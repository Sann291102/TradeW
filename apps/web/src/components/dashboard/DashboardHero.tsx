'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkline, Surface, AnimatedNumber, cn } from '@tradew/ui';
import { INDEX_QUOTES } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useCandles } from '@/lib/hooks/useCandles';
import { useSessionStore } from '@/lib/store/sessionStore';
import { toDisplayRow, directionClass } from '@/lib/markets/quoteDisplay';
import { changeOrDash, fmtPrice, pctOrDash, NO_VALUE } from '@/lib/format';

/** "Good morning/afternoon/evening" by IST clock — NSE's own timezone, matching
 *  every other timestamp in the app (see lib/news.ts `newsTime`). Computed
 *  client-side only: a server-rendered greeting would reflect the server's
 *  own clock/timezone and could disagree with the visitor's, so this starts
 *  `null` and fills in after mount (same hydration-safety pattern as
 *  `useSignedIn` in PortfolioClient.tsx). */
function useIstGreeting(): string | null {
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()),
    );
    setGreeting(hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
  }, []);
  return greeting;
}

/** First name-ish token from an email's local part, title-cased —
 *  "vivek.sharma@x.com" -> "Vivek". Falls back to "Trader" when signed out,
 *  same spirit as `initials()` in lib/format.ts. */
function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const token = local.split(/[._-]/)[0] || local;
  return token ? token[0].toUpperCase() + token.slice(1) : 'Trader';
}

/**
 * DashboardHero — the greeting banner at the top of the Market Workspace,
 * from the reference layout: a time-of-day greeting on the left, a live
 * NIFTY 50 mini-card on the right. Same live/fallback contract as
 * `IndexOverview` (real Dhan tick when reachable, mock preview otherwise) —
 * just narrowed to one symbol. Market open/closed state itself is shown only
 * once app-wide, in TopBar's `MarketStatus` pill next to the page title —
 * not repeated here.
 */
export function DashboardHero() {
  const greeting = useIstGreeting();
  const sessionUser = useSessionStore((s) => s.user);
  const name = sessionUser ? firstNameFromEmail(sessionUser.email) : 'Trader';

  const { quotes, status } = useDhanLiveFeed();
  const live = (status === 'live' || status === 'closed') && quotes;
  const liveNifty = live ? quotes.find((q) => q.symbol === 'NIFTY') : undefined;
  const mockNifty = INDEX_QUOTES.find((q) => q.symbol === 'NIFTY');
  // One row shape whether the source is the bridge or the preview data, so the
  // markup below has no branch that could default a price differently.
  const nifty = liveNifty
    ? toDisplayRow(liveNifty)
    : !live && mockNifty
      ? {
          ltp: mockNifty.ltp,
          price: fmtPrice(mockNifty.ltp),
          changeText: changeOrDash(mockNifty.change),
          changePctText: pctOrDash(mockNifty.changePct),
          direction: mockNifty.change >= 0 ? ('up' as const) : ('down' as const),
          atPreviousClose: false,
        }
      : null;

  // The live snapshot itself carries no history (LTP only) — the same real
  // intraday candles MarketOverview charts (Dhan bridge `/candles`) back this
  // sparkline too, rather than leaving it empty or fabricating a shape.
  const { candles } = useCandles(live ? 'NIFTY' : '', '5m', 1);
  const niftySpark = live
    ? (candles ?? []).map((c) => c.close)
    : (INDEX_QUOTES.find((q) => q.symbol === 'NIFTY')?.spark ?? []);

  return (
    <Surface elevation={2} className="grid grid-cols-1 overflow-hidden sm:grid-cols-[1.4fr_1fr]">
      <div className="relative flex flex-col justify-center gap-1 px-5 py-6 sm:px-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,var(--teal-bg),transparent_60%)]"
        />
        <h1 className="relative text-xl font-bold text-text">
          {greeting ?? 'Welcome'}, {name}! <span aria-hidden="true">👋</span>
        </h1>
        <p className="relative text-sm text-muted">
          {status === 'live'
            ? "Markets are open — here's what's moving right now."
            : 'Markets are closed. Track global cues and prepare for tomorrow.'}
        </p>
      </div>

      <div className="flex flex-col justify-center gap-2 border-t border-border px-5 py-5 sm:border-l sm:border-t-0 sm:px-6">
        <Link href="/trade?symbol=NIFTY" className="text-[11px] font-semibold uppercase tracking-wide text-faint hover:text-teal">
          NIFTY 50
        </Link>
        {nifty ? (
          <div className="flex items-center gap-3">
            <div className="shrink-0">
              {/* Unknown price renders as "—", never animated up from 0.00. */}
              {nifty.ltp === null ? (
                <span className="block text-2xl font-bold text-muted">{NO_VALUE}</span>
              ) : (
                <AnimatedNumber value={nifty.ltp} format={fmtPrice} className="block px-0 text-2xl font-bold text-text" />
              )}
              <span className={cn('font-mono text-xs tabular-nums', directionClass(nifty.direction))}>
                {nifty.changeText} ({nifty.changePctText})
              </span>
              {nifty.atPreviousClose && (
                // The pill above says "Market closed"; without this the number
                // beside it read as a live quote. Naming the price's vintage is
                // the difference between a frozen price and a wrong one.
                <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-faint">At previous close</span>
              )}
            </div>
            <Sparkline data={niftySpark} width={160} height={56} className="w-full flex-1" aria-label="NIFTY 50 trend" />
          </div>
        ) : (
          <div className="h-14 motion-safe:animate-pulse rounded-md bg-border2/60" />
        )}
      </div>
    </Surface>
  );
}
