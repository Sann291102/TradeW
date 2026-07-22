'use client';

import Link from 'next/link';
import { Card, Sparkline, Badge, cn } from '@tradew/ui';
import { WATCHLIST } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { fmt, pct } from '@/lib/format';

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
        live ? (
          <Badge tone={status === 'live' ? 'positive' : 'neutral'} className="px-1.5 py-0 text-[9px]">
            {status === 'live' ? 'LIVE' : 'CLOSED'}
          </Badge>
        ) : (
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">PREVIEW</Badge>
        )
      }
    >
      <ul className="divide-y divide-border">
        {WATCHLIST.map((w) => {
          const liveMatch = liveBySymbol?.get(w.symbol);
          const ltp = liveMatch?.ltp ?? w.ltp;
          const changePct = liveMatch?.changePct ?? w.changePct;
          const up = changePct >= 0;
          return (
            <li key={w.symbol}>
              <Link href="/markets" className="flex items-center gap-3 rounded py-2 transition-colors duration-micro hover:bg-hover">
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
    </Card>
  );
}
