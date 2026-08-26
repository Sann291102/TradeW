'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CandleLoader } from '@tradew/ui';
import { fetchPeerResearch } from '@/lib/research/api';
import type { PeriodType } from '@/lib/research/types';
import { percent, ratio } from '@/lib/research/format';
import { DataUnavailable, NotReported } from './DataUnavailable';

export function PeerResearchPanel({ symbol, periodType }: { symbol: string; periodType: PeriodType }) {
  const query = useQuery({
    queryKey: ['research', 'peers', symbol, periodType],
    queryFn: () => fetchPeerResearch(symbol, periodType),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  return (
    <Card title="Peer & sector research" subtitle="· locally cached comparables only">
      {query.isPending && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading peers for ${symbol}`} />
        </div>
      )}

      {query.isError && (
        <DataUnavailable
          title="Peer comparison unavailable"
          reason={query.error instanceof Error ? query.error.message : 'The peer-comparison service did not answer.'}
        />
      )}

      {query.data && !query.data.available && (
        <DataUnavailable title="Peer comparison unavailable" reason={query.data.reason} />
      )}

      {query.data?.available && (
        <div className="space-y-4">
          <p className="text-[11px] text-faint">
            Subject classification: {query.data.data.subject.sector ?? 'sector not reported'} ·{' '}
            {query.data.data.subject.industry ?? 'industry not reported'}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[11px]">
              <thead className="text-faint">
                <tr className="border-b border-border">
                  <th className="py-1 text-left font-semibold">Company</th>
                  <th className="py-1 text-right font-semibold">P/E</th>
                  <th className="py-1 text-right font-semibold">P/B</th>
                  <th className="py-1 text-right font-semibold">P/S</th>
                  <th className="py-1 text-right font-semibold">EV/EBITDA</th>
                  <th className="py-1 text-right font-semibold">Revenue growth</th>
                  <th className="py-1 text-right font-semibold">Net margin</th>
                  <th className="py-1 text-right font-semibold">ROE</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.peers.map((peer) => (
                  <tr key={peer.symbol} className="border-b border-border">
                    <td className="py-1.5 text-muted">
                      <div className="font-semibold text-text">{peer.symbol}</div>
                      <div className="text-[10.5px] text-faint">{peer.name}</div>
                    </td>
                    <Cell value={peer.metrics.pe} formatter={ratio} />
                    <Cell value={peer.metrics.pb} formatter={ratio} />
                    <Cell value={peer.metrics.ps} formatter={ratio} />
                    <Cell value={peer.metrics.ev_ebitda} formatter={ratio} />
                    <Cell value={peer.metrics.revenue_growth} formatter={percent} />
                    <Cell value={peer.metrics.net_margin} formatter={percent} />
                    <Cell value={peer.metrics.roe} formatter={percent} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="list-disc space-y-1 pl-4 text-[11px] text-faint">
            {query.data.data.unavailableDetails.map((detail, index) => (
              <li key={index}>{detail}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Cell({ value, formatter }: { value: number | undefined; formatter: (value: number) => string }) {
  return <td className="py-1.5 text-right text-text">{value !== undefined ? formatter(value) : <NotReported />}</td>;
}
