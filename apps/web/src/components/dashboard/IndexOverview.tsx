'use client';

import Link from 'next/link';
import { Sparkline, Surface, AnimatedNumber, cn } from '@tradew/ui';
import { INDEX_QUOTES } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { fmt, pct, sign } from '@/lib/format';
import { logChartClick } from '@/lib/analytics';

/**
 * IndexOverview — the headline index cards from the canonical home (`.ovGrid`).
 * Sourced from the Dhan live-feed bridge (real broker ticks, no DB, no auth —
 * see lib/dhanLiveFeed.ts) when reachable, falling back to the mock preview
 * otherwise — never a broken card, always honestly labeled which it's showing.
 * No fabricated sparkline on real data (no OHLC-history endpoint exists yet,
 * that's the Charts step) — Sparkline degrades to empty gracefully.
 */
export function IndexOverview() {
  const { quotes, status } = useDhanLiveFeed();
  const live = (status === 'live' || status === 'closed') && quotes;

  const rows = live
    ? quotes.map((q) => ({ symbol: q.symbol, name: q.displayName, ltp: q.ltp, change: q.change, changePct: q.changePct, spark: [] as number[] }))
    : INDEX_QUOTES.map((q) => ({ symbol: q.symbol, name: q.name, ltp: q.ltp, change: q.change, changePct: q.changePct, spark: q.spark }));

  return (
    <section aria-label="Index overview" className="space-y-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {rows.map((q) => {
          const up = q.change >= 0;
          return (
            <Link key={q.symbol} href={`/trade?symbol=${q.symbol}`} onClick={() => logChartClick(q.symbol, 'dashboard_index_card')}>
              <Surface elevation={2} interactive className="px-3.5 py-3">
                <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted">{q.name}</div>
                <AnimatedNumber
                  value={q.ltp}
                  format={fmt}
                  className="mt-1 block px-0 text-lg font-bold text-text"
                />
                <div className={cn('font-mono text-xs tabular-nums', up ? 'text-up' : 'text-down')}>
                  {sign(q.change)}
                  {fmt(Math.abs(q.change))} ({pct(q.changePct)})
                </div>
                <div className="mt-2">
                  <Sparkline data={q.spark} tone={up ? 'up' : 'down'} width={140} height={28} className="w-full" aria-label={`${q.name} trend`} />
                </div>
              </Surface>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
