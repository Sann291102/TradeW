import { Card, cn } from '@tradew/ui';
import { GLOBAL_MARKETS } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';

/**
 * GlobalMarkets — world indices strip for the Market Workspace's "what's
 * happening in the market right now" landing view. Independent widget,
 * mirrors IndexOverview's card language at a smaller scale.
 */
export function GlobalMarkets() {
  return (
    <Card title="Global Markets">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {GLOBAL_MARKETS.map((g) => {
          const up = g.changePct >= 0;
          return (
            <div key={g.symbol} className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-muted">{g.name}</div>
              <div className="font-mono text-sm font-bold tabular-nums text-text">{fmt(g.ltp)}</div>
              <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>{pct(g.changePct)}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
