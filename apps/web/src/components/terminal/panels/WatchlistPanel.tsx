import { Panel, Sparkline, cn } from '@tradew/ui';
import { WATCHLIST } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';
import type { DockPanelContentProps } from './types';

/** Watchlist slot — the canonical left-rail watchlist as a terminal panel. */
export function WatchlistPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel title="Watchlist" className={className} actions={actions} collapsed={collapsed}>
      <ul className="-mx-1 divide-y divide-border">
        {WATCHLIST.map((w) => {
          const up = w.changePct >= 0;
          return (
            <li key={w.symbol} className="flex items-center gap-2 px-1 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-text">{w.symbol}</div>
                <div className="truncate text-[10px] text-faint">{w.name}</div>
              </div>
              <Sparkline data={w.spark} width={44} height={16} aria-label={`${w.symbol} trend`} />
              <div className="w-16 text-right">
                <div className="font-mono text-[12px] tabular-nums text-text">{fmt(w.ltp)}</div>
                <div className={cn('font-mono text-[10px] tabular-nums', up ? 'text-up' : 'text-down')}>{pct(w.changePct)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
