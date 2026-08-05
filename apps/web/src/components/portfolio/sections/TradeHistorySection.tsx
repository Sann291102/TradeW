'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, EmptyState, Skeleton, buttonClasses, cn } from '@tradew/ui';
import { fmt, inr, sign } from '@/lib/format';
import { type TradeHistoryFilters, type TradeHistoryRow, downloadTradeHistoryCsv, fetchTradeHistory } from '@/lib/oms';
import { Pagination } from '../Pagination';

const PAGE_SIZE = 25;

export function TradeHistorySection() {
  const [filters, setFilters] = useState<{ from: string; to: string; symbol: string; search: string }>({
    from: '',
    to: '',
    symbol: '',
    search: '',
  });
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TradeHistoryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const activeFilters: TradeHistoryFilters = {
    from: filters.from || undefined,
    to: filters.to || undefined,
    symbol: filters.symbol || undefined,
    search: filters.search || undefined,
    page,
    pageSize: PAGE_SIZE,
  };

  const load = useCallback(async () => {
    try {
      const res = await fetchTradeHistory(activeFilters);
      setRows(res.rows);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load trade history');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to, filters.symbol, filters.search, page]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  function updateFilter(key: keyof typeof filters, value: string) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function onExport() {
    setExporting(true);
    try {
      await downloadTradeHistoryCsv({ from: activeFilters.from, to: activeFilters.to, symbol: activeFilters.symbol, search: activeFilters.search });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export trade history');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          From
          <input
            type="date"
            value={filters.from}
            onChange={(e) => updateFilter('from', e.target.value)}
            className="mt-1 block rounded-lg border border-border2 bg-bg px-2.5 py-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>
        <label className="text-xs text-muted">
          To
          <input
            type="date"
            value={filters.to}
            onChange={(e) => updateFilter('to', e.target.value)}
            className="mt-1 block rounded-lg border border-border2 bg-bg px-2.5 py-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>
        <label className="text-xs text-muted">
          Symbol
          <input
            type="text"
            placeholder="e.g. RELIANCE"
            value={filters.symbol}
            onChange={(e) => updateFilter('symbol', e.target.value.toUpperCase())}
            className="mt-1 block w-32 rounded-lg border border-border2 bg-bg px-2.5 py-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>
        <label className="flex-1 text-xs text-muted">
          Search
          <input
            type="text"
            placeholder="Symbol or name"
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
            className="mt-1 block w-full rounded-lg border border-border2 bg-bg px-2.5 py-1.5 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </label>
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), 'disabled:opacity-50')}
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          {error}
        </p>
      )}

      {rows === null && !error ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows && rows.length > 0 ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-faint">
                  <th className="py-2 pr-3">Date &amp; Time</th>
                  <th className="py-2 pr-3">Symbol</th>
                  <th className="py-2 pr-3">Side</th>
                  <th className="py-2 pr-3 text-right">Qty</th>
                  <th className="py-2 pr-3 text-right">Entry Price</th>
                  <th className="py-2 pr-3 text-right">Exit Price</th>
                  <th className="py-2 pr-3 text-right">Net P&L</th>
                  <th className="py-2 pl-3 text-right">Charges</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 text-[11px] text-muted">{new Date(r.executedAt).toLocaleString()}</td>
                    <td className="py-2 pr-3 font-bold text-text">{r.symbol}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={r.side === 'BUY' ? 'positive' : 'negative'} className="px-1.5 py-0 text-[9px]">
                        {r.side}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{r.quantity}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{fmt(r.entryPrice)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{fmt(r.exitPrice)}</td>
                    <td className={cn('py-2 pr-3 text-right font-mono tabular-nums font-semibold', r.netPnl >= 0 ? 'text-up' : 'text-down')}>
                      {sign(r.netPnl)}
                      {inr(Math.abs(r.netPnl), 2)}
                    </td>
                    <td className="py-2 pl-3 text-right font-mono tabular-nums text-muted">{inr(r.charges, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
        </>
      ) : (
        <EmptyState title="No trades yet" description="Round-trip trades (a position opened and later closed) show up here once you've squared something off." />
      )}
    </div>
  );
}
