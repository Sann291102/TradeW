'use client';

import { useState } from 'react';
import { Card, cn } from '@tradew/ui';
import { TOP_GAINERS, TOP_LOSERS, type MoverRow } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';

const TABS = [
  { key: 'g', label: '▲ Gainers' },
  { key: 'l', label: '▼ Losers' },
] as const;

/**
 * MarketMovers — the "Market Movers" card with gainer/loser tabs from the
 * canonical home. Interactive (tabbed) → client component. Independent widget.
 */
export function MarketMovers() {
  const [tab, setTab] = useState<'g' | 'l'>('g');
  const rows: MoverRow[] = tab === 'g' ? TOP_GAINERS : TOP_LOSERS;
  return (
    <Card title="Market Movers">
      <div role="tablist" aria-label="Movers filter" className="mb-3 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              tab === t.key ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const up = r.changePct >= 0;
          return (
            <li key={r.symbol} className="flex items-center justify-between gap-3 py-2">
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
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
