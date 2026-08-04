'use client';

import Link from 'next/link';
import { Card, cn } from '@tradew/ui';
import { TRENDING } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { pct } from '@/lib/format';

/**
 * TrendingStocks — the "Trending Stocks" chip row from the canonical home.
 * changePct uses the real Dhan quote when the bridge covers the symbol
 * (lib/dhanLiveFeed.ts); each chip links to its chart.
 */
export function TrendingStocks() {
  const { stocks: liveStocks, status } = useDhanLiveFeed();
  const live = status === 'live' || status === 'closed';

  return (
    <Card title="Trending Stocks">
      <div className="flex flex-wrap gap-2">
        {TRENDING.map((t) => {
          const liveMatch = live ? liveStocks?.find((lq) => lq.symbol === t.symbol) : undefined;
          const changePct = liveMatch?.changePct ?? t.changePct;
          const up = changePct >= 0;
          return (
            <Link
              key={t.symbol}
              href={`/trade?symbol=${t.symbol}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border2 px-2.5 py-1 text-xs font-semibold text-text transition-colors duration-micro hover:bg-hover"
            >
              {t.symbol}
              <span className={cn('font-mono tabular-nums', up ? 'text-up' : 'text-down')}>{pct(changePct)}</span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
