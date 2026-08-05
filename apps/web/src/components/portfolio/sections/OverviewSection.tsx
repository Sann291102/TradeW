'use client';

import { Skeleton, StatCard } from '@tradew/ui';
import { inr, pct, sign } from '@/lib/format';
import type { PortfolioSummary } from '@/lib/oms';

/** Portfolio Summary — the seven stat tiles the spec's §1 asks for, all from
 *  PortfolioService.summary() (services/api/src/sim/portfolio.service.ts). */
export function OverviewSection({ summary }: { summary: PortfolioSummary | null }) {
  if (!summary) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  const pctOfStart = (v: number) => (summary.startingBalance ? pct((v / summary.startingBalance) * 100) : undefined);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label="Available Balance" value={inr(summary.availableBalance, 2)} />
      <StatCard label="Invested Amount" value={inr(summary.investedAmount, 2)} />
      <StatCard label="Current Value" value={inr(summary.currentValue, 2)} />
      <StatCard
        label="Today's P&L"
        value={`${sign(summary.dailyPnl)}${inr(Math.abs(summary.dailyPnl), 2)}`}
        delta={pctOfStart(summary.dailyPnl)}
      />
      <StatCard
        label="Overall P&L"
        value={`${sign(summary.overallPnl)}${inr(Math.abs(summary.overallPnl), 2)}`}
        delta={pctOfStart(summary.overallPnl)}
      />
      <StatCard label="Margin Used" value={inr(summary.marginUsed, 2)} />
      <StatCard label="Available Margin" value={inr(summary.availableMargin, 2)} />
    </div>
  );
}
