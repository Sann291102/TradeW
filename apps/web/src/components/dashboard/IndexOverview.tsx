'use client';

import { Sparkline, Badge, cn } from '@tradew/ui';
import { INDEX_QUOTES } from '@/lib/mock/market';
import { DASHBOARD_INDEX_SYMBOLS } from '@/lib/marketData';
import { useLiveQuotes } from '@/lib/hooks/useLiveQuotes';
import { fmt, pct, sign } from '@/lib/format';

/**
 * IndexOverview — the headline index cards from the canonical home (`.ovGrid`).
 * Milestone 4, Step 2: now backed by the real (simulated-engine) market-data
 * API when reachable/authenticated, falling back to the M2 mock preview
 * otherwise — never a broken card, always honestly labeled which it's showing.
 * No fabricated sparkline on real data (no OHLC-history endpoint exists yet,
 * that's the Charts step) — Sparkline degrades to empty gracefully.
 */
export function IndexOverview() {
  const { quotes, status } = useLiveQuotes([...DASHBOARD_INDEX_SYMBOLS]);
  const live = status === 'live' && quotes;

  const rows = live
    ? quotes.map((q) => ({ symbol: q.symbol, name: q.displayName, ltp: q.ltp, change: q.change, changePct: q.changePct, spark: [] as number[] }))
    : INDEX_QUOTES.map((q) => ({ symbol: q.symbol, name: q.name, ltp: q.ltp, change: q.change, changePct: q.changePct, spark: q.spark }));

  return (
    <section aria-label="Index overview" className="space-y-2">
      <div className="flex items-center gap-2">
        {live ? (
          <Badge tone="positive" className="px-1.5 py-0 text-[9px]">LIVE</Badge>
        ) : (
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
            {status === 'loading' ? 'LOADING' : 'PREVIEW'}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {rows.map((q) => {
          const up = q.change >= 0;
          return (
            <div key={q.symbol} className="rounded-card border border-border bg-card p-3 shadow-card">
              <div className="text-[11px] font-semibold text-muted">{q.name}</div>
              <div className="mt-1 font-mono text-lg font-bold tabular-nums text-text">{fmt(q.ltp)}</div>
              <div className={cn('font-mono text-xs tabular-nums', up ? 'text-up' : 'text-down')}>
                {sign(q.change)}
                {fmt(Math.abs(q.change))} ({pct(q.changePct)})
              </div>
              <div className="mt-2">
                <Sparkline data={q.spark} width={140} height={28} className="w-full" aria-label={`${q.name} trend`} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
