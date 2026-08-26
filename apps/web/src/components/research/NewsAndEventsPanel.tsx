'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CandleLoader } from '@tradew/ui';
import { fetchResearchNews } from '@/lib/research/api';
import { asOf } from '@/lib/research/format';
import { DataUnavailable } from './DataUnavailable';

export function NewsAndEventsPanel({ symbol }: { symbol: string }) {
  const query = useQuery({
    queryKey: ['research', 'news', symbol],
    queryFn: () => fetchResearchNews(symbol),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <Card title="Company news" subtitle="· real articles with visible evidence">
      {query.isPending && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading news for ${symbol}`} />
        </div>
      )}

      {query.isError && (
        <DataUnavailable
          title="Company news unavailable"
          reason={query.error instanceof Error ? query.error.message : 'The news service did not answer.'}
        />
      )}

      {query.data && !query.data.available && (
        <DataUnavailable title="Company news unavailable" reason={query.data.reason} />
      )}

      {query.data?.available && (
        <div className="space-y-3">
          {query.data.data.items.map((item) => (
            <article key={item.id} className="rounded-lg border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {item.source}
                </Badge>
                <Badge tone={toneForSentiment(item.sentiment)} className="px-1.5 py-0 text-[9px] capitalize">
                  {item.sentiment}
                </Badge>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {item.eventClassification.replace(/_/g, ' ')}
                </Badge>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  impact {item.eventImpact}
                </Badge>
                {item.categories.map((category) => (
                  <Badge key={`${item.id}-${category}`} tone="neutral" className="px-1.5 py-0 text-[9px]">
                    {category}
                  </Badge>
                ))}
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block text-sm font-semibold text-text hover:text-teal hover:underline"
              >
                {item.title}
              </a>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{item.summary}</p>
              <p className="mt-2 text-[10.5px] text-faint">Published {asOf(item.publishedAt)}</p>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}

function toneForSentiment(sentiment: 'positive' | 'negative' | 'neutral'): 'positive' | 'negative' | 'neutral' {
  if (sentiment === 'positive') return 'positive';
  if (sentiment === 'negative') return 'negative';
  return 'neutral';
}
