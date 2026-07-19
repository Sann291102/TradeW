'use client';

import { useState } from 'react';
import { Card, StatCard, EmptyState, cn } from '@tradew/ui';
import { PORTFOLIO_SUMMARY as P } from '@/lib/mock/market';
import { inr, sign } from '@/lib/format';

const TABS = ['Holdings', 'Positions', 'Performance', 'Journal'] as const;
type Tab = (typeof TABS)[number];

/**
 * Portfolio workspace — converted from the canonical `pagePortfolio`. Summary
 * stat cards + tabbed sections (Holdings/Positions/Performance/Journal). M2
 * shows summary metrics from mock data and empty states for the tables (the
 * backend holdings/positions data wires in a later milestone).
 */
export default function PortfolioPage() {
  const [tab, setTab] = useState<Tab>('Holdings');
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Invested" value={inr(P.investment)} />
        <StatCard label="Current" value={inr(P.currentValue)} />
        <StatCard label="Overall P&L" value={`${sign(P.overallPnl)}${inr(P.overallPnl)}`} delta={`${sign(P.overallPnl)}5.41%`} />
        <StatCard label="Today's P&L" value={`${sign(P.todayPnl)}${inr(P.todayPnl)}`} delta={`${sign(P.todayPnl)}0.94%`} />
      </section>

      <div role="tablist" aria-label="Portfolio sections" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              tab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <Card title={tab}>
        <EmptyState
          title={`No ${tab.toLowerCase()} to show yet`}
          description="Your paper-account data appears here once the trading backend is connected."
        />
      </Card>
    </div>
  );
}
