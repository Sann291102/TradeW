'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, Badge, cn } from '@tradew/ui';
import { TOP_GAINERS, TOP_LOSERS, type MoverRow } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { fmt, pct } from '@/lib/format';

const TABS = [
  { key: 'g', label: '▲ Gainers' },
  { key: 'l', label: '▼ Losers' },
] as const;

/**
 * MarketMovers — the "Market Movers" card with gainer/loser tabs from the
 * canonical home. Interactive (tabbed) → client component. Independent widget.
 *
 * Real gainers/losers change every session — a fixed symbol list can never
 * match that (a stock hardcoded as a "gainer" would show as one even on a day
 * it's down). So when the Dhan bridge is reachable, this ranks the live
 * stock universe by actual changePct and shows whichever symbols are really
 * up/down most today — the mock TOP_GAINERS/TOP_LOSERS lists are only the
 * fallback when live data is unavailable.
 */
export function MarketMovers() {
  const [tab, setTab] = useState<'g' | 'l'>('g');
  const { stocks: liveStocks, status } = useDhanLiveFeed();
  const live = (status === 'live' || status === 'closed') && !!liveStocks && liveStocks.length > 0;

  const rows: MoverRow[] = live
    ? [...liveStocks!]
        .sort((a, b) => (tab === 'g' ? b.changePct - a.changePct : a.changePct - b.changePct))
        .filter((q) => (tab === 'g' ? q.changePct > 0 : q.changePct < 0))
        .slice(0, 5)
        .map((q) => ({ symbol: q.symbol, name: q.displayName, ltp: q.ltp, changePct: q.changePct }))
    : tab === 'g'
      ? TOP_GAINERS
      : TOP_LOSERS;

  return (
    <Card
      title="Market Movers"
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
      <div role="tablist" aria-label="Movers filter" className="mb-3 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              tab === t.key ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-faint">No real {tab === 'g' ? 'gainers' : 'losers'} in today's tracked universe.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const up = r.changePct >= 0;
            return (
              <li key={r.symbol}>
                <Link
                  href={`/trade?symbol=${r.symbol}`}
                  className="flex items-center justify-between gap-3 rounded py-2 transition-colors duration-micro hover:bg-hover"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-text">{r.symbol}</div>
                    <div className="truncate text-[11px] text-faint">{r.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm tabular-nums text-text">{fmt(r.ltp)}</div>
                    <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                      {pct(r.changePct)}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
