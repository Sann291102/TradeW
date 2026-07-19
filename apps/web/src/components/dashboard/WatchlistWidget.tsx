import { Card, Sparkline, cn } from '@tradew/ui';
import { WATCHLIST } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';

/**
 * WatchlistWidget — the sidebar watchlist from the canonical terminal, as a
 * dashboard card: symbol + name + sparkline + LTP + change. Independent widget.
 * (The full sidebar-docked watchlist returns as a terminal panel in Step 6.)
 */
export function WatchlistWidget() {
  return (
    <Card title="Watchlist" subtitle="· My Watchlist">
      <ul className="divide-y divide-border">
        {WATCHLIST.map((w) => {
          const up = w.changePct >= 0;
          return (
            <li key={w.symbol} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-text">{w.symbol}</div>
                <div className="truncate text-[11px] text-faint">{w.name}</div>
              </div>
              <Sparkline data={w.spark} width={56} height={20} aria-label={`${w.symbol} trend`} />
              <div className="w-20 text-right">
                <div className="font-mono text-sm tabular-nums text-text">{fmt(w.ltp)}</div>
                <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                  {pct(w.changePct)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
