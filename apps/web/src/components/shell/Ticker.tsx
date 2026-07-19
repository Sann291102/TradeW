'use client';

import { useReducedMotion } from 'framer-motion';
import { cn } from '@tradew/ui';
import { INDEX_QUOTES, TICKER_EXTRA, type IndexQuote } from '@/lib/mock/market';
import { DASHBOARD_INDEX_SYMBOLS } from '@/lib/marketData';
import { useLiveQuotes } from '@/lib/hooks/useLiveQuotes';
import { fmt, pct } from '@/lib/format';

function TickerItem({ q }: { q: IndexQuote }) {
  const up = q.change >= 0;
  return (
    <span className="mx-4 inline-flex items-baseline gap-2 whitespace-nowrap">
      <span className="text-xs font-semibold text-muted">{q.name}</span>
      <span className="font-mono text-xs font-bold tabular-nums text-text">{fmt(q.ltp)}</span>
      <span className={cn('font-mono text-xs tabular-nums', up ? 'text-up' : 'text-down')}>
        {pct(q.changePct)}
      </span>
    </span>
  );
}

/**
 * Market ticker (Milestone 2, Step 4; real data Milestone 4, Step 2) — the
 * scrolling index strip. The 5 dashboard indices use the real (simulated-
 * engine) market-data API when reachable/authenticated; the extra sector
 * indices (TICKER_EXTRA — not seeded as DB instruments yet) stay on the M2
 * preview data. Colors are market-direction only. Honors reduced-motion.
 */
export function Ticker() {
  const reduce = useReducedMotion();
  const { quotes, status } = useLiveQuotes([...DASHBOARD_INDEX_SYMBOLS]);

  if (status === 'loading') {
    return (
      <div className="flex h-9 shrink-0 items-center gap-6 overflow-hidden border-b border-border bg-card px-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3 w-28 motion-safe:animate-pulse rounded bg-border2/60" />
        ))}
      </div>
    );
  }

  const primary: IndexQuote[] =
    status === 'live' && quotes
      ? quotes.map((q) => ({ symbol: q.symbol, name: q.displayName, ltp: q.ltp, change: q.change, changePct: q.changePct, spark: [] }))
      : INDEX_QUOTES;
  const items = [...primary, ...TICKER_EXTRA];

  if (reduce) {
    return (
      <div
        className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-border bg-card"
        aria-label="Market index prices"
      >
        {items.map((q) => (
          <TickerItem key={q.symbol} q={q} />
        ))}
      </div>
    );
  }

  return (
    <div
      className="group relative flex h-9 shrink-0 items-center overflow-hidden border-b border-border bg-card"
      aria-label="Market index prices"
    >
      {/* two copies for a seamless loop; pause on hover for readability */}
      <div className="tw-ticker flex min-w-full shrink-0 items-center group-hover:[animation-play-state:paused]">
        {items.map((q) => (
          <TickerItem key={`a-${q.symbol}`} q={q} />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="tw-ticker flex min-w-full shrink-0 items-center group-hover:[animation-play-state:paused]"
      >
        {items.map((q) => (
          <TickerItem key={`b-${q.symbol}`} q={q} />
        ))}
      </div>
    </div>
  );
}
