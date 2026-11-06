'use client';

import { useReducedMotion } from 'framer-motion';
import { cn, Badge } from '@tradew/ui';
import { INDEX_QUOTES, TICKER_EXTRA } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { toDisplayRow, directionClass, directionOf, type QuoteDisplayRow } from '@/lib/markets/quoteDisplay';
import { changeOrDash, fmtPrice, pctOrDash } from '@/lib/format';

function TickerItem({ q }: { q: QuoteDisplayRow }) {
  return (
    <span className="mx-4 inline-flex items-baseline gap-2 whitespace-nowrap">
      <span className="text-xs font-semibold text-muted">{q.name}</span>
      <span className="font-mono text-xs font-bold tabular-nums text-text">{q.price}</span>
      <span className={cn('font-mono text-xs tabular-nums', directionClass(q.direction))}>{q.changePctText}</span>
    </span>
  );
}

/** The mock preview rows (TICKER_EXTRA, and INDEX_QUOTES when the bridge is
 *  unreachable) through the same projection, so preview and live data render
 *  by one set of rules rather than two. */
function previewRow(q: { symbol: string; name: string; ltp: number; change: number; changePct: number }): QuoteDisplayRow {
  return {
    symbol: q.symbol,
    name: q.name,
    ltp: q.ltp,
    change: q.change,
    changePct: q.changePct,
    price: fmtPrice(q.ltp),
    changeText: changeOrDash(q.change),
    changePctText: pctOrDash(q.changePct),
    direction: directionOf(q.change),
    atPreviousClose: false,
    priceSource: null,
  };
}

function MarketStatusBadge({ status }: { status: 'loading' | 'live' | 'closed' | 'unreachable' }) {
  if (status === 'live') return <Badge tone="positive" className="px-1.5 py-0 text-[9px]">MARKET LIVE</Badge>;
  if (status === 'closed') return <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">MARKET CLOSED</Badge>;
  if (status === 'loading') return <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">LOADING</Badge>;
  return <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">PREVIEW</Badge>;
}

/**
 * Market ticker (Milestone 2, Step 4) — the scrolling index strip. The 5
 * dashboard indices are sourced from the Dhan live-feed bridge (real broker
 * ticks, no DB, no auth — lib/dhanLiveFeed.ts) when reachable; the extra
 * sector indices (TICKER_EXTRA — not on Dhan's index set here) stay on the M2
 * preview data. Colors are market-direction only. Honors reduced-motion.
 */
export function Ticker() {
  const reduce = useReducedMotion();
  const { quotes, status } = useDhanLiveFeed();

  if (status === 'loading') {
    return (
      <div className="flex h-9 shrink-0 items-center gap-6 overflow-hidden border-b border-border bg-card px-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3 w-28 motion-safe:animate-pulse rounded bg-border2/60" />
        ))}
      </div>
    );
  }

  const primary: QuoteDisplayRow[] =
    (status === 'live' || status === 'closed') && quotes
      ? quotes.map(toDisplayRow)
      : INDEX_QUOTES.map(previewRow);
  const items = [...primary, ...TICKER_EXTRA.map(previewRow)];

  if (reduce) {
    return (
      <div
        className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-card px-3"
        aria-label="Market index prices"
      >
        <div className="shrink-0"><MarketStatusBadge status={status} /></div>
        {items.map((q) => (
          <TickerItem key={q.symbol} q={q} />
        ))}
      </div>
    );
  }

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-card pl-3"
      aria-label="Market index prices"
    >
      <div className="shrink-0"><MarketStatusBadge status={status} /></div>
      {/* Badge lives outside the scrolling track on purpose: the marquee
          translates the whole track across 100%+ of its own width on a loop,
          so any fixed label placed *inside* it gets swept over repeatedly. */}
      <div className="group relative flex h-full flex-1 items-center overflow-hidden">
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
    </div>
  );
}
