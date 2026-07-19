import { Card, cn } from '@tradew/ui';
import { TRENDING } from '@/lib/mock/market';
import { pct } from '@/lib/format';

/**
 * TrendingStocks — the "Trending Stocks" chip row from the canonical home.
 * Independent widget (Step 5).
 */
export function TrendingStocks() {
  return (
    <Card title="Trending Stocks">
      <div className="flex flex-wrap gap-2">
        {TRENDING.map((t) => {
          const up = t.changePct >= 0;
          return (
            <span
              key={t.symbol}
              className="inline-flex items-center gap-1.5 rounded-full border border-border2 px-2.5 py-1 text-xs font-semibold text-text"
            >
              {t.symbol}
              <span className={cn('font-mono tabular-nums', up ? 'text-up' : 'text-down')}>{pct(t.changePct)}</span>
            </span>
          );
        })}
      </div>
    </Card>
  );
}
