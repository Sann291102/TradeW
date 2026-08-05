'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Badge, Skeleton, EmptyState } from '@tradew/ui';
import { NEWS_POLL_MS, fetchNews, newsTime, type NewsItem } from '@/lib/news';

const CATEGORY_TONE: Record<string, 'neutral' | 'brand' | 'warning'> = {
  MARKETS: 'brand',
  STOCKS: 'brand',
  BUSINESS: 'neutral',
  ECONOMY: 'warning',
};

const DASHBOARD_LIMIT = 3;

/**
 * MarketNews (dashboard card) — was a hardcoded `NEWS` array from
 * lib/mock/market.ts labeled "mock feed"; the full `/news` route already
 * moved to the real newswire endpoint (`fetchNews()` in lib/news.ts,
 * see `app/news/NewsClient.tsx`) but nothing on the dashboard used it. Same
 * real fetch here, capped to a handful of headlines, "View All" -> /news for
 * the full live list.
 */
export function MarketNews() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const next = await fetchNews(DASHBOARD_LIMIT);
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
    <Card
      title="Market News"
      actions={
        <Link href="/news" className="text-xs font-semibold text-teal hover:underline">
          View All
        </Link>
      }
    >
      {error ? (
        <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          {error}
        </p>
      ) : items === null ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="No headlines right now" />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((n) => (
            <li key={n.id} className="py-2 first:pt-0 last:pb-0">
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
                  <span className="line-clamp-2 text-sm text-text group-hover:text-teal">{n.title}</span>
                </div>
                <div className="mt-1 font-mono text-[10px] tabular-nums text-faint">
                  {newsTime(n.publishedAt)} · {n.publisher}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
