import Link from 'next/link';
import { Panel, cn } from '@tradew/ui';
import { PORTFOLIO_SUMMARY as P } from '@/lib/mock/market';
import { inr, sign } from '@/lib/format';
import type { DockPanelContentProps } from './types';

/**
 * Portfolio mini panel — a compact summary for the dock (Milestone 3's "Portfolio
 * ... coexist" panel kind), linking to the full `/portfolio` workspace for the
 * deep-dive tabs. Mirrors the dashboard's PortfolioSummary at dock scale.
 */
export function PortfolioMiniPanel({ className, actions, collapsed }: DockPanelContentProps) {
  const overallUp = P.overallPnl >= 0;
  const todayUp = P.todayPnl >= 0;
  return (
    <Panel title="Portfolio" className={className} actions={actions} collapsed={collapsed} scroll={false}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-faint">Current value</div>
          <div className="font-mono text-sm font-bold tabular-nums text-text">{inr(P.currentValue)}</div>
        </div>
        <div>
          <div className="text-faint">Today&apos;s P&amp;L</div>
          <div className={cn('font-mono text-sm font-bold tabular-nums', todayUp ? 'text-up' : 'text-down')}>
            {sign(P.todayPnl)}
            {inr(P.todayPnl)}
          </div>
        </div>
        <div>
          <div className="text-faint">Overall P&amp;L</div>
          <div className={cn('font-mono text-sm tabular-nums', overallUp ? 'text-up' : 'text-down')}>
            {sign(P.overallPnl)}
            {inr(P.overallPnl)}
          </div>
        </div>
        <div>
          <div className="text-faint">Open positions</div>
          <div className="font-mono text-sm tabular-nums text-text">{P.openPositions}</div>
        </div>
      </div>
      <Link href="/portfolio" className="mt-3 inline-block text-[11px] font-semibold text-teal hover:underline">
        Open full Portfolio workspace →
      </Link>
    </Panel>
  );
}
