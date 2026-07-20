'use client';

import Link from 'next/link';
import { Card, AnimatedNumber, cn } from '@tradew/ui';
import { PORTFOLIO_SUMMARY as P } from '@/lib/mock/market';
import { inr, sign } from '@/lib/format';

function Metric({ label, value, tone, signed }: { label: string; value: number; tone?: 'up' | 'down'; signed?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <AnimatedNumber
        value={value}
        countUpOnMount
        format={(n) => `${signed ? sign(n) : ''}${inr(n)}`}
        className={cn(
          'block px-0 text-base font-bold',
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text',
        )}
      />
    </div>
  );
}

/**
 * PortfolioSummary — the "My Portfolio" card from the canonical home:
 * investment / current value / overall P&L / today's P&L headline metrics plus
 * the margin/equity sub-row. Links to /portfolio. Mock paper account.
 */
export function PortfolioSummary() {
  const overallTone = P.overallPnl >= 0 ? 'up' : 'down';
  const todayTone = P.todayPnl >= 0 ? 'up' : 'down';
  return (
    <Link href="/portfolio" className="block">
      <Card title="My Portfolio" subtitle="· paper account" elevation={2} className="transition-colors hover:border-border2">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Investment" value={P.investment} />
          <Metric label="Current value" value={P.currentValue} />
          <Metric label="Overall P&L" value={P.overallPnl} tone={overallTone} signed />
          <Metric label="Today's P&L" value={P.todayPnl} tone={todayTone} signed />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-xs text-muted">
          <span>Open positions: <b className="text-text">{P.openPositions}</b></span>
          <span>Margin available: <b className="font-mono tabular-nums text-text">{inr(P.marginAvailable)}</b></span>
          <span>Margin used: <b className="font-mono tabular-nums text-text">{inr(P.marginUsed)}</b></span>
          <span>Equity: <b className="font-mono tabular-nums text-text">{inr(P.equity)}</b></span>
        </div>
      </Card>
    </Link>
  );
}
