'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CandleLoader } from '@tradew/ui';
import { fetchEarningsIntelligence } from '@/lib/research/api';
import type { PeriodType } from '@/lib/research/types';
import { asOfDate, compactMoney, percent } from '@/lib/research/format';
import { DataUnavailable, NotReported } from './DataUnavailable';

export function EarningsIntelligencePanel({ symbol, periodType }: { symbol: string; periodType: PeriodType }) {
  const query = useQuery({
    queryKey: ['research', 'earnings', symbol, periodType],
    queryFn: () => fetchEarningsIntelligence(symbol, periodType),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  return (
    <Card title="Earnings intelligence" subtitle={`· ${periodType}`}>
      {query.isPending && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading earnings for ${symbol}`} />
        </div>
      )}

      {query.isError && (
        <DataUnavailable
          title="Earnings intelligence unavailable"
          reason={query.error instanceof Error ? query.error.message : 'The earnings service did not answer.'}
        />
      )}

      {query.data && !query.data.available && (
        <DataUnavailable title="Earnings intelligence unavailable" reason={query.data.reason} />
      )}

      {query.data?.available && (
        <div className="space-y-4">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-teal">History</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[560px] text-[11px]">
                <thead className="text-faint">
                  <tr className="border-b border-border">
                    <th className="py-1 text-left font-semibold">Period</th>
                    <th className="py-1 text-right font-semibold">Revenue</th>
                    <th className="py-1 text-right font-semibold">Revenue growth</th>
                    <th className="py-1 text-right font-semibold">EPS</th>
                    <th className="py-1 text-right font-semibold">EPS growth</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.data.history.map((row) => (
                    <tr key={row.periodEnd} className="border-b border-border">
                      <td className="py-1.5 text-muted">
                        FY{row.fiscalYear}
                        {row.fiscalQuarter ? ` Q${row.fiscalQuarter}` : ''} · {asOfDate(row.periodEnd)}
                      </td>
                      <td className="py-1.5 text-right text-text">
                        {row.revenue !== undefined && row.currency ? compactMoney(row.revenue, row.currency) : <NotReported />}
                      </td>
                      <td className="py-1.5 text-right text-text">
                        {row.revenueGrowthPct !== undefined ? percent(row.revenueGrowthPct) : <NotReported />}
                      </td>
                      <td className="py-1.5 text-right text-text">
                        {row.eps !== undefined ? row.eps.toFixed(2) : <NotReported />}
                      </td>
                      <td className="py-1.5 text-right text-text">
                        {row.epsGrowthPct !== undefined ? percent(row.epsGrowthPct) : <NotReported />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-teal">Upcoming events</h3>
              <div className="mt-2 space-y-2">
                {query.data.data.upcoming.length === 0 && (
                  <p className="text-[11px] text-faint">No upcoming earnings-related corporate events were found in the current NSE calendar.</p>
                )}
                {query.data.data.upcoming.map((event, index) => (
                  <div key={`${event.symbol ?? 'event'}-${event.date ?? index}`} className="rounded-lg border border-border px-3 py-2">
                    <p className="text-[11.5px] font-semibold text-text">{event.purpose ?? 'Corporate event'}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      {(event.company ?? event.symbol ?? symbol)} · {event.date ?? 'date unavailable'}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-teal">Recent earnings articles</h3>
              <div className="mt-2 space-y-2">
                {query.data.data.recentEarningsNews.length === 0 && (
                  <p className="text-[11px] text-faint">No recent earnings-tagged articles were found in the current company news feed.</p>
                )}
                {query.data.data.recentEarningsNews.map((item) => (
                  <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-border px-3 py-2 transition-colors hover:bg-hover">
                    <p className="text-[11.5px] font-semibold text-text">{item.title}</p>
                    <p className="mt-1 text-[11px] text-faint">{item.source} · {asOfDate(item.publishedAt)}</p>
                  </a>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-teal">Unavailable today</h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-faint">
              {query.data.data.unavailableDetails.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Card>
  );
}
