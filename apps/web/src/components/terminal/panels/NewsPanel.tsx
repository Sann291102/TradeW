'use client';

import { Panel, Badge, Skeleton, type BadgeTone } from '@tradew/ui';
import { newsTime } from '@/lib/news';
import { useNews } from '@/lib/query/useNews';
import type { DockPanelContentProps } from './types';

/**
 * News slot — the terminal's compact feed, now on real newswires.
 *
 * Previously rendered `NEWS` from lib/mock/market.ts: five hardcoded headlines
 * with frozen timestamps, beside live prices. Same feed as the /news route, so
 * the terminal and the Market News page can never disagree.
 *
 * Headlines link out to the publisher and are not interpreted here — see
 * services/api/src/news/news.service.ts for why the classifier stays off.
 */

const TONE: Record<string, BadgeTone> = {
  MARKETS: 'brand',
  STOCKS: 'brand',
  BUSINESS: 'neutral',
  ECONOMY: 'warning',
};

export function NewsPanel({ className, actions, collapsed }: DockPanelContentProps) {
  // Shares one cached request with the dashboard card and /news. Collapsing
  // the panel no longer discards the headlines it had — re-opening reads the
  // cache and shows them instantly, then refreshes behind the numbers.
  const { items, error, refetch } = useNews(12);

  return (
    <Panel title="News" className={className} actions={actions} collapsed={collapsed}>
      {error && (
        <p className="text-[11px] leading-relaxed text-amber">
          {error}{' '}
          <button type="button" onClick={refetch} className="font-semibold underline underline-offset-2">
            Try again
          </button>
        </p>
      )}

      {!items && !error && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {items && !error && (
        <ul className="space-y-2">
          {items.slice(0, 6).map((n) => (
            <li key={n.id} className="flex items-start gap-2">
              <Badge tone={TONE[n.category] ?? 'neutral'} className="mt-0.5 shrink-0 px-1 py-0 text-[8px]">
                {n.category}
              </Badge>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <p className="text-[12px] leading-snug text-text group-hover:text-teal">{n.title}</p>
                <span className="font-mono text-[10px] tabular-nums text-faint">
                  {newsTime(n.publishedAt)} · {n.publisher}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
