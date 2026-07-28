'use client';

import { useEffect, useState } from 'react';
import { Badge, Card, Skeleton, cn } from '@tradew/ui';
import { NEWS_POLL_MS, fetchNews, newsTime, type NewsItem } from '@/lib/news';

/**
 * Market News — real headlines from Indian financial newswires.
 *
 * Previously six hardcoded strings in lib/mock/market.ts with frozen
 * timestamps, rendered on the dashboard as though it were a live feed.
 *
 * Headlines only: each item links out to the publisher. TradeW deliberately
 * does not summarise, score or interpret them — saying what a headline MEANS
 * for an instrument is a short step from a recommendation, and this product
 * observes rather than instructs. Reporting what was published is not that.
 */

const CATEGORY_TONE: Record<string, 'neutral' | 'brand' | 'warning'> = {
  MARKETS: 'brand',
  STOCKS: 'brand',
  BUSINESS: 'neutral',
  ECONOMY: 'warning',
};

export function NewsClient() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const next = await fetchNews();
        if (cancelled) return;
        setItems(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load market news');
      } finally {
        if (!cancelled) timer = setTimeout(tick, NEWS_POLL_MS);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="mx-auto max-w-[900px] space-y-4 p-4">
      <Card
        title="Market News"
        subtitle="· live newswires"
        actions={
          items && !error ? (
            <Badge tone="positive" className="px-1.5 py-0 text-[9px]">
              {items.length}
            </Badge>
          ) : undefined
        }
      >
        {error && (
          <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
            {error}
          </p>
        )}

        {!items && !error && (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {items && !error && (
          <ul className="divide-y divide-border">
            {items.map((n) => (
              <li key={n.id} className="py-2.5 first:pt-0 last:pb-0">
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block rounded-lg px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={CATEGORY_TONE[n.category] ?? 'neutral'} className="px-1.5 py-0 text-[9px]">
                      {n.category}
                    </Badge>
                    <span className="text-sm font-semibold leading-snug text-text group-hover:text-teal">
                      {n.title}
                    </span>
                  </div>
                  {n.summary && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{n.summary}</p>
                  )}
                  <div className={cn('mt-1 font-mono text-[10px] tabular-nums text-faint')}>
                    {newsTime(n.publishedAt)} · {n.publisher}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          Headlines are published by the sources named and link out to them. TradeW does not interpret them or
          suggest what to trade.
        </p>
      </Card>
    </div>
  );
}
