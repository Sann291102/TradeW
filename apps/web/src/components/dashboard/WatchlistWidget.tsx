'use client';

import Link from 'next/link';
import { Card, Sparkline, cn } from '@tradew/ui';
import { WATCHLIST } from '@/lib/mock/market';

/** Reference shows 5 rows; the full WATCHLIST const carries 2 more (kept for
 *  other consumers, e.g. the terminal panel) — sliced here to match density
 *  and to keep this card's height in line with its Market Alerts/News
 *  neighbors below it (see MarketWorkspace.tsx's balanced two-column row). */
const DASHBOARD_ROWS = 5;
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { fmt, pct } from '@/lib/format';
import { PlusIcon } from '@/components/shell/icons';

/**
 * WatchlistWidget — the sidebar watchlist from the canonical terminal, as a
 * dashboard card: symbol + name + sparkline + LTP + change. Independent widget.
 * (The full sidebar-docked watchlist returns as a terminal panel in Step 6.)
 *
 * Every WATCHLIST symbol happens to be covered by the Dhan bridge (indices +
 * stocks), so ltp/changePct overlay live per-row when reachable — same
 * merge-by-symbol pattern as CommodityMarkets. Sparkline stays the mock
 * series regardless (no OHLC-history endpoint from the bridge yet).
 */
export function WatchlistWidget() {
  const { quotes, stocks, status } = useDhanLiveFeed();
  const live = status === 'live' || status === 'closed';
  const liveBySymbol = live ? new Map([...(quotes ?? []), ...(stocks ?? [])].map((q) => [q.symbol, q])) : null;

  return (
    <Card
      title="Watchlist"
      subtitle="· My Watchlist"
      actions={
        <button
          type="button"
          disabled
          title="Custom watchlists aren't wired to a backend yet — this list is fixed for now."
          aria-disabled="true"
          className="cursor-not-allowed text-xs font-semibold text-faint"
        >
          Manage
        </button>
      }
    >
      <ul className="divide-y divide-border">
        {WATCHLIST.slice(0, DASHBOARD_ROWS).map((w) => {
          const liveMatch = liveBySymbol?.get(w.symbol);
          const ltp = liveMatch?.ltp ?? w.ltp;
          const changePct = liveMatch?.changePct ?? w.changePct;
          const up = changePct >= 0;
          return (
            <li key={w.symbol}>
              <Link href="/markets" className="flex items-center gap-3 rounded py-1.5 transition-colors duration-micro hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-text">{w.symbol}</div>
                  <div className="truncate text-[11px] text-faint">{w.name}</div>
                </div>
                <Sparkline data={w.spark} width={56} height={20} aria-label={`${w.symbol} trend`} />
                <div className="w-20 text-right">
                  <div className="font-mono text-sm tabular-nums text-text">{fmt(ltp)}</div>
                  <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                    {pct(changePct)}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled
        title="Adding symbols needs a watchlist-CRUD endpoint that doesn't exist yet — integration point, not wired."
        aria-disabled="true"
        className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-border2 py-2 text-xs font-semibold text-faint"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Add Symbol
      </button>
    </Card>
  );
}
