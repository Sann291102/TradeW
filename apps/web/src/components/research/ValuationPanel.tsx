'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CandleLoader } from '@tradew/ui';
import { fetchResearchValuation } from '@/lib/research/api';
import type { PeriodType } from '@/lib/research/types';
import { compactMoney, formatRatio } from '@/lib/research/format';
import { DataUnavailable } from './DataUnavailable';

export function ValuationPanel({ symbol, periodType }: { symbol: string; periodType: PeriodType }) {
  const query = useQuery({
    queryKey: ['research', 'valuation', symbol, periodType],
    queryFn: () => fetchResearchValuation(symbol, periodType),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  return (
    <Card title="Valuation" subtitle="· provider data, calculated metrics and explicit gaps">
      {query.isPending && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading valuation for ${symbol}`} />
        </div>
      )}

      {query.isError && (
        <DataUnavailable
          title="Valuation unavailable"
          reason={query.error instanceof Error ? query.error.message : 'The valuation service did not answer.'}
        />
      )}

      {query.data && !query.data.available && <DataUnavailable title="Valuation unavailable" reason={query.data.reason} />}

      {query.data?.available && (
        (() => {
          const data = query.data.data;
          return (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.metrics.map((metric) => (
              <div key={metric.key} className="rounded-lg border border-border px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-faint">{metric.label}</p>
                  <Badge tone={metric.source === 'provider' ? 'neutral' : 'positive'} className="px-1.5 py-0 text-[9px]">
                    {metric.source}
                  </Badge>
                </div>
                <p className="mt-1 text-base font-semibold text-text">
                  {metric.unit === 'currency' && data.currency
                    ? compactMoney(metric.value, data.currency)
                    : formatRatio(metric.value, metric.unit, data.currency ?? undefined)}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-faint">{metric.detail}</p>
              </div>
            ))}
          </div>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-teal">Scenario analysis</h3>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              {data.scenarios.map((scenario) => (
                <div key={scenario.label} className="rounded-lg border border-border px-3 py-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-faint">{scenario.label}</p>
                  <p className="mt-1 text-[11px] text-muted">{scenario.basis}</p>
                  <p className="mt-2 text-sm font-semibold text-text">
                    {scenario.impliedPrice !== undefined && data.currency
                      ? compactMoney(scenario.impliedPrice, data.currency)
                      : scenario.reason ?? 'not available'}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-teal">Unavailable today</h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-faint">
              {data.unavailableDetails.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          </section>
        </div>
          );
        })()
      )}
    </Card>
  );
}
