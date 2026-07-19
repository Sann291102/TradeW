import { Card, cn } from '@tradew/ui';
import { PORTFOLIO_SUMMARY as P } from '@/lib/mock/market';
import { inr, sign } from '@/lib/format';

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <div className={cn('font-mono text-base font-bold tabular-nums', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text')}>
        {value}
      </div>
    </div>
  );
}

/**
 * PortfolioSummary — the "My Portfolio" card from the canonical home:
 * investment / current value / overall P&L / today's P&L headline metrics plus
 * the margin/equity sub-row. Independent widget (Step 5). Mock paper account.
 */
export function PortfolioSummary() {
  const overallTone = P.overallPnl >= 0 ? 'up' : 'down';
  const todayTone = P.todayPnl >= 0 ? 'up' : 'down';
  return (
    <Card title="My Portfolio" subtitle="· paper account">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Investment" value={inr(P.investment)} />
        <Metric label="Current value" value={inr(P.currentValue)} />
        <Metric label="Overall P&L" value={`${sign(P.overallPnl)}${inr(P.overallPnl)}`} tone={overallTone} />
        <Metric label="Today's P&L" value={`${sign(P.todayPnl)}${inr(P.todayPnl)}`} tone={todayTone} />
      </div>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-xs text-muted">
        <span>Open positions: <b className="text-text">{P.openPositions}</b></span>
        <span>Margin available: <b className="font-mono tabular-nums text-text">{inr(P.marginAvailable)}</b></span>
        <span>Margin used: <b className="font-mono tabular-nums text-text">{inr(P.marginUsed)}</b></span>
        <span>Equity: <b className="font-mono tabular-nums text-text">{inr(P.equity)}</b></span>
      </div>
    </Card>
  );
}
