'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CandleLoader } from '@tradew/ui';
import { fetchKnowledgeGraph } from '@/lib/research/api';
import { DataUnavailable } from './DataUnavailable';

export function KnowledgeGraphPanel({ symbol }: { symbol: string }) {
  const query = useQuery({
    queryKey: ['research', 'graph', symbol],
    queryFn: () => fetchKnowledgeGraph(symbol),
    staleTime: 30_000,
    retry: 1,
  });

  return (
    <Card title="Knowledge graph" subtitle="· relationships backed by the entity graph">
      {query.isPending && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading graph relationships for ${symbol}`} />
        </div>
      )}

      {query.isError && (
        <DataUnavailable
          title="Knowledge-graph relationships unavailable"
          reason={query.error instanceof Error ? query.error.message : 'The graph service did not answer.'}
        />
      )}

      {query.data && !query.data.available && (
        <DataUnavailable title="Knowledge-graph relationships unavailable" reason={query.data.reason} />
      )}

      {query.data?.available && (
        <div className="space-y-2">
          <p className="text-[11px] text-faint">Entity node: {query.data.data.nodeId}</p>
          {query.data.data.relationships.map((relation, index) => (
            <div key={`${relation.targetId}-${index}`} className="rounded-lg border border-border px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {relation.relation}
                </Badge>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {relation.targetType}
                </Badge>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  weight {relation.weight.toFixed(2)}
                </Badge>
              </div>
              <p className="mt-1 text-[11.5px] font-semibold text-text">{relation.targetLabel}</p>
              <p className="mt-1 text-[10.5px] text-faint">{relation.targetId}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
