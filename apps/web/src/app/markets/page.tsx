'use client';

import { useState } from 'react';
import { Card, cn } from '@tradew/ui';
import { INDEX_QUOTES, TICKER_EXTRA } from '@/lib/mock/market';
import { fmt, pct, sign } from '@/lib/format';

const CATEGORIES = ['Indices', 'Stocks', 'Futures', 'Options', 'ETFs', 'Commodities'] as const;
const ALL_INDICES = [...INDEX_QUOTES, ...TICKER_EXTRA];

/**
 * Markets workspace — converted from the canonical `pageMarkets`. Category tabs
 * over a quotes table. Milestone 2: Indices tab shows mock quotes; other
 * categories show a "coming with the live feed" empty state (UI architecture,
 * not full logic).
 */
export default function MarketsPage() {
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>('Indices');
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <div role="tablist" aria-label="Market categories" className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={cat === c}
            onClick={() => setCat(c)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              cat === c ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      <Card title={cat}>
        {cat === 'Indices' ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-faint">
                <tr className="border-b border-border text-left">
                  <th className="py-2 font-semibold">Name</th>
                  <th className="py-2 text-right font-semibold">LTP</th>
                  <th className="py-2 text-right font-semibold">Change</th>
                  <th className="py-2 text-right font-semibold">% Chg</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {ALL_INDICES.map((q) => {
                  const up = q.change >= 0;
                  return (
                    <tr key={q.symbol} className="border-b border-border">
                      <td className="py-2 font-sans font-semibold text-text">{q.name}</td>
                      <td className="py-2 text-right text-text">{fmt(q.ltp)}</td>
                      <td className={cn('py-2 text-right', up ? 'text-up' : 'text-down')}>
                        {sign(q.change)}
                        {fmt(Math.abs(q.change))}
                      </td>
                      <td className={cn('py-2 text-right', up ? 'text-up' : 'text-down')}>{pct(q.changePct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
