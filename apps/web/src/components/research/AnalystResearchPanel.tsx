'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CandleLoader } from '@tradew/ui';
import { fetchAnalystResearch } from '@/lib/research/api';
import { asOf, compactMoney } from '@/lib/research/format';
import { DataUnavailable } from './DataUnavailable';

export function AnalystResearchPanel({ symbol }: { symbol: string }) {
  const query = useQuery({
    queryKey: ['research', 'analyst', symbol],
    queryFn: () => fetchAnalystResearch(symbol),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <Card title="Analyst research" subtitle="· only what current articles explicitly state">
      {query.isPending && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading analyst research for ${symbol}`} />
        </div>
      )}

      {query.isError && (
        <DataUnavailable
          title="Analyst research unavailable"
          reason={query.error instanceof Error ? query.error.message : 'The analyst-research service did not answer.'}
        />
      )}

      {query.data && !query.data.available && (
        <DataUnavailable title="Analyst research unavailable" reason={query.data.reason} />
      )}

      {query.data?.available && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Metric label="Buy" value={String(query.data.data.distribution.buy)} tone="positive" />
            <Metric label="Hold" value={String(query.data.data.distribution.hold)} tone="neutral" />
            <Metric label="Sell" value={String(query.data.data.distribution.sell)} tone="negative" />
            <Metric
              label="Target range"
              value={
                query.data.data.targetRange
                  ? `${compactMoney(query.data.data.targetRange.low, query.data.data.targetRange.currency)} – ${compactMoney(
                      query.data.data.targetRange.high,
                      query.data.data.targetRange.currency,
                    )}`
                  : 'not available'
              }
              tone="neutral"
            />
          </div>

          <p className="text-[11px] leading-relaxed text-faint">{query.data.data.coverageNote}</p>

          <div className="space-y-2">
            {query.data.data.items.map((item) => (
              <article key={item.articleId} className="rounded-lg border border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                    {item.source}
                  </Badge>
                  {item.rating && (
                    <Badge tone={item.rating === 'buy' ? 'positive' : item.rating === 'sell' ? 'negative' : 'neutral'} className="px-1.5 py-0 text-[9px] uppercase">
                      {item.rating}
                    </Badge>
                  )}
                  {item.previousRating && (
                    <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                      from {item.previousRating}
                    </Badge>
                  )}
                </div>
                <a href={item.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm font-semibold text-text hover:text-teal hover:underline">
                  {item.title}
                </a>
                <p className="mt-1 text-[11.5px] text-muted">
                  {[item.brokerName, item.analystName].filter(Boolean).join(' · ') || 'Source article'} · {asOf(item.publishedAt)}
                </p>
                {item.priceTarget !== undefined && item.currency && (
                  <p className="mt-1 text-[11.5px] text-muted">
                    Price target: <span className="font-semibold text-text">{compactMoney(item.priceTarget, item.currency)}</span>
                  </p>
                )}
                {item.commentary && <p className="mt-1 text-[11px] leading-relaxed text-faint">{item.commentary}</p>}
              </article>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'positive' | 'negative' | 'neutral';
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="text-[10.5px] uppercase tracking-wide text-faint">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${tone === 'positive' ? 'text-up' : tone === 'negative' ? 'text-down' : 'text-text'}`}>
        {value}
      </p>
    </div>
  );
}
