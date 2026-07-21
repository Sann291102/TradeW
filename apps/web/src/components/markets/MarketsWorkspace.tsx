'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, cn } from '@tradew/ui';
import { SECTORS, SECTOR_STOCKS } from '@/lib/mock/market';
import { ALL_NSE_INDICES } from '@/lib/mock/indices';
import { FO_STOCK_UNIVERSE } from '@/lib/mock/foUniverse';
import { fmt, pct } from '@/lib/format';

const CATEGORIES = ['Indices', 'Stocks', 'Futures', 'Options', 'ETFs', 'Commodities'] as const;

/**
 * Markets workspace — converted from the canonical `pageMarkets`. Category tabs
 * over a quotes table.
 *
 * Indices tab: every NSE index (`ALL_NSE_INDICES`, 139 rows — real dated
 * figures from the user-supplied `MW-All-Indices-*.csv`, not placeholder
 * mock data, see lib/mock/indices.ts), filterable by name.
 *
 * Stocks tab: every NSE F&O-eligible stock is browsable/searchable
 * (`FO_STOCK_UNIVERSE`, ~208 symbols from `NSE_FO_SosScheme.csv` — see
 * lib/mock/foUniverse.ts). `?sector=<key>` (from Sector Heatmap tile links)
 * narrows this to one sector's constituents, which additionally carry
 * illustrative mock LTP/% change (`SECTOR_STOCKS`) — the rest of the
 * universe is symbol+name only until real per-stock pricing is wired in.
 */
export function MarketsWorkspace() {
  const searchParams = useSearchParams();
  const sectorParam = searchParams.get('sector');
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>(sectorParam ? 'Stocks' : 'Indices');
  const [sector, setSector] = useState<string | null>(sectorParam);
  const [indexFilter, setIndexFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');

  // a new ?sector= link (clicking a different heatmap tile while already on
  // this page) should re-open the filter, not be stuck on the first value
  useEffect(() => {
    if (sectorParam) {
      setSector(sectorParam);
      setCat('Stocks');
    }
  }, [sectorParam]);

  const sectorMeta = sector ? SECTORS.find((s) => s.key === sector) : null;
  const sectorStocks = sector ? SECTOR_STOCKS[sector] : null;

  const filteredIndices = useMemo(() => {
    const q = indexFilter.trim().toLowerCase();
    if (!q) return ALL_NSE_INDICES;
    return ALL_NSE_INDICES.filter((i) => i.name.toLowerCase().includes(q));
  }, [indexFilter]);

  const filteredUniverse = useMemo(() => {
    const q = stockFilter.trim().toLowerCase();
    if (!q) return FO_STOCK_UNIVERSE;
    return FO_STOCK_UNIVERSE.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [stockFilter]);

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <div role="tablist" aria-label="Market categories" className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={cat === c}
            onClick={() => {
              setCat(c);
              if (c !== 'Stocks') setSector(null);
            }}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              cat === c ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      <Card
        title={cat === 'Stocks' && sectorMeta ? `Stocks — ${sectorMeta.name}` : cat === 'Indices' ? `Indices (${ALL_NSE_INDICES.length})` : cat === 'Stocks' ? `Stocks (${FO_STOCK_UNIVERSE.length})` : cat}
        actions={
          cat === 'Stocks' && sector ? (
            <button onClick={() => setSector(null)} className="text-xs font-semibold text-teal hover:underline">
              ← All sectors
            </button>
          ) : cat === 'Indices' ? (
            <input
              value={indexFilter}
              onChange={(e) => setIndexFilter(e.target.value)}
              placeholder="Filter indices…"
              className="w-40 rounded-lg border border-border2 bg-bg px-2.5 py-1 text-xs text-text placeholder:text-faint focus:border-teal focus:outline-none"
            />
          ) : cat === 'Stocks' && !sector ? (
            <input
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value)}
              placeholder="Filter stocks…"
              className="w-40 rounded-lg border border-border2 bg-bg px-2.5 py-1 text-xs text-text placeholder:text-faint focus:border-teal focus:outline-none"
            />
          ) : undefined
        }
      >
        {cat === 'Indices' ? (
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-card text-faint">
                <tr className="border-b border-border text-left">
                  <th className="py-2 font-semibold">Name</th>
                  <th className="py-2 text-right font-semibold">Current</th>
                  <th className="py-2 text-right font-semibold">% Chg</th>
                  <th className="py-2 text-right font-semibold">52W High</th>
                  <th className="py-2 text-right font-semibold">52W Low</th>
                  <th className="py-2 text-right font-semibold">30D %</th>
                  <th className="py-2 text-right font-semibold">365D %</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {filteredIndices.map((idx) => {
                  const up = (idx.changePct ?? 0) >= 0;
                  return (
                    <tr key={idx.name} className="border-b border-border">
                      <td className="py-2 font-sans font-semibold text-text">{idx.name}</td>
                      <td className="py-2 text-right text-text">{fmt(idx.current)}</td>
                      <td className={cn('py-2 text-right', idx.changePct == null ? 'text-faint' : up ? 'text-up' : 'text-down')}>
                        {idx.changePct == null ? '—' : pct(idx.changePct)}
                      </td>
                      <td className="py-2 text-right text-muted">{idx.week52High != null ? fmt(idx.week52High) : '—'}</td>
                      <td className="py-2 text-right text-muted">{idx.week52Low != null ? fmt(idx.week52Low) : '—'}</td>
                      <td className={cn('py-2 text-right', idx.chg30D == null ? 'text-faint' : idx.chg30D >= 0 ? 'text-up' : 'text-down')}>
                        {idx.chg30D != null ? pct(idx.chg30D) : '—'}
                      </td>
                      <td className={cn('py-2 text-right', idx.chg365D == null ? 'text-faint' : idx.chg365D >= 0 ? 'text-up' : 'text-down')}>
                        {idx.chg365D != null ? pct(idx.chg365D) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {filteredIndices.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center font-sans text-muted">
                      No indices match &ldquo;{indexFilter}&rdquo;.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : cat === 'Stocks' && sectorStocks ? (
          <ul className="divide-y divide-border">
            {sectorStocks.map((r) => {
              const up = r.changePct >= 0;
              return (
                <li key={r.symbol}>
                  <Link
                    href={`/trade?symbol=${r.symbol}`}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 -mx-2 transition-colors duration-micro hover:bg-hover"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-text">{r.symbol}</div>
                      <div className="truncate text-[11px] text-faint">{r.name}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm tabular-nums text-text">{fmt(r.ltp)}</div>
                      <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                        {pct(r.changePct)}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : cat === 'Stocks' ? (
          <div className="max-h-[560px] overflow-auto">
            <p className="mb-3 text-[11.5px] text-faint">
              Every NSE F&amp;O-eligible stock — symbol/name only until real per-stock pricing is wired in. Pick a
              sector from the Sector Heatmap for a subset with illustrative prices.
            </p>
            <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              {filteredUniverse.map((s) => (
                <li key={s.symbol}>
                  <Link
                    href={`/trade?symbol=${s.symbol}`}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 -mx-2 transition-colors duration-micro hover:bg-hover"
                  >
                    <span className="truncate text-sm font-semibold text-text">{s.symbol}</span>
                    <span className="truncate text-[11px] text-faint">{s.name}</span>
                  </Link>
                </li>
              ))}
              {filteredUniverse.length === 0 && (
                <li className="col-span-2 py-6 text-center text-sm text-muted">No stocks match &ldquo;{stockFilter}&rdquo;.</li>
              )}
            </ul>
          </div>
        ) : (
          <div className="py-10 text-center text-sm text-muted">
            {cat} listings arrive with the live market-data feed.
          </div>
        )}
      </Card>
    </div>
  );
}
