'use client';

import Link from 'next/link';
import { Sparkline, Surface, AnimatedNumber, cn } from '@tradew/ui';
import { INDEX_QUOTES } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { toDisplayRow, directionClass, type QuoteDisplayRow } from '@/lib/markets/quoteDisplay';
import { changeOrDash, fmtPrice, pctOrDash } from '@/lib/format';
import { logChartClick } from '@/lib/analytics';

/**
 * IndexOverview — the headline index cards from the canonical home (`.ovGrid`).
 * Sourced from the Dhan live-feed bridge (real broker ticks, no DB, no auth —
 * see lib/dhanLiveFeed.ts) when reachable, falling back to the mock preview
 * otherwise — never a broken card, always honestly labeled which it's showing.
 * No fabricated sparkline on real data (no OHLC-history endpoint exists yet,
 * that's the Charts step) — Sparkline degrades to empty gracefully.
 *
 * These are the five cards that read 0.00 with the market shut. They render
 * whatever `toDisplayRow` returns and hold no fallback of their own: the price
 * shown outside session hours is the last valid one the bridge observed, and
 * "—" on the rare card the bridge has never seen a price for.
 */
export function IndexOverview() {
  const { quotes, status } = useDhanLiveFeed();
  const live = (status === 'live' || status === 'closed') && quotes;

  const rows: Array<QuoteDisplayRow & { spark: number[] }> = live
    ? quotes.map((q) => ({ ...toDisplayRow(q), spark: [] as number[] }))
    : INDEX_QUOTES.map((q) => ({
        symbol: q.symbol,
        name: q.name,
        ltp: q.ltp,
        change: q.change,
        changePct: q.changePct,
        price: fmtPrice(q.ltp),
        changeText: changeOrDash(q.change),
        changePctText: pctOrDash(q.changePct),
        direction: q.change >= 0 ? ('up' as const) : ('down' as const),
        atPreviousClose: false,
        priceSource: null,
        spark: q.spark,
      }));

  return (
    <section aria-label="Index overview" className="space-y-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {rows.map((q) => (
          <Link key={q.symbol} href={`/trade?symbol=${q.symbol}`} onClick={() => logChartClick(q.symbol, 'dashboard_index_card')}>
            <Surface elevation={2} interactive className="px-3.5 py-3">
              <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted">{q.name}</div>
              {/* AnimatedNumber tweens between two numbers, so it has nothing to
                  show for an unknown price — the "—" is rendered as plain text
                  rather than animated from zero, which would literally count a
                  card up from 0.00 and reintroduce the number this fixes. */}
              {q.ltp === null ? (
                <div className="mt-1 text-lg font-bold text-muted" title="No price observed yet">
                  {q.price}
                </div>
              ) : (
                <AnimatedNumber value={q.ltp} format={fmtPrice} className="mt-1 block px-0 text-lg font-bold text-text" />
              )}
              <div className={cn('font-mono text-xs tabular-nums', directionClass(q.direction))}>
                {q.changeText} ({q.changePctText})
              </div>
              <div className="mt-2">
                <Sparkline
                  data={q.spark}
                  tone={q.direction === 'down' ? 'down' : 'up'}
                  width={140}
                  height={28}
                  className="w-full"
                  aria-label={`${q.name} trend`}
                />
              </div>
            </Surface>
          </Link>
        ))}
      </div>
    </section>
  );
}
