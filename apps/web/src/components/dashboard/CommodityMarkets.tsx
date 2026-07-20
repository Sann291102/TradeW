import { Card, cn } from '@tradew/ui';
import { COMMODITIES } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';

/**
 * CommodityMarkets — MCX commodities strip (Gold/Silver/Crude/Natural Gas/
 * Copper) for the Market Workspace landing page. Sits under GlobalMarkets in
 * the same column so that section's card fills the row height instead of
 * leaving dead space next to the taller Risk Alerts card.
 */
export function CommodityMarkets() {
  return (
    <Card title="Commodities" subtitle="· MCX">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {COMMODITIES.map((c) => {
          const up = c.changePct >= 0;
          return (
            <div key={c.symbol} className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-muted">
                {c.name} <span className="text-faint">/{c.unit}</span>
              </div>
              <div className="font-mono text-sm font-bold tabular-nums text-text">{fmt(c.ltp)}</div>
              <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>{pct(c.changePct)}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
