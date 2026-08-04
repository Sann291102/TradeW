'use client';

import Link from 'next/link';
import { Card, Badge, cn } from '@tradew/ui';
import { COMMODITIES } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { fmt, pct } from '@/lib/format';

/**
 * CommodityMarkets — MCX commodities strip (Gold/Silver/Crude/Natural Gas/
 * Copper) for the Market Workspace landing page. Sits under GlobalMarkets in
 * the same column so that section's card fills the row height instead of
 * leaving dead space next to the taller Risk Alerts card.
 *
 * Backed by real Dhan front-month futures ticks (lib/dhanLiveFeed.ts) when
 * the bridge is reachable — MCX runs its own session (independent of the
 * NSE open/closed flag elsewhere in the app), so this card carries its own
 * LIVE badge rather than reusing the index one.
 */
export function CommodityMarkets() {
  const { commodities: liveCommodities, status } = useDhanLiveFeed();
  const live = status === 'live' || status === 'closed';

  return (
    <Card
      title="Commodities"
      subtitle="· MCX"
      actions={
        live ? (
          <Badge tone="positive" className="px-1.5 py-0 text-[9px]">LIVE</Badge>
        ) : (
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">PREVIEW</Badge>
        )
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {COMMODITIES.map((c) => {
          const liveMatch = live ? liveCommodities?.find((lq) => lq.symbol === c.symbol) : undefined;
          const ltp = liveMatch?.ltp ?? c.ltp;
          const changePct = liveMatch?.changePct ?? c.changePct;
          const up = changePct >= 0;
          return (
            <Link
              key={c.symbol}
              href={`/trade?symbol=${c.symbol}`}
              className="min-w-0 rounded transition-colors duration-micro hover:bg-hover"
            >
              <div className="truncate text-[11px] font-semibold text-muted">
                {c.name} <span className="text-faint">/{c.unit}</span>
              </div>
              <div className="font-mono text-sm font-bold tabular-nums text-text">{fmt(ltp)}</div>
              <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>{pct(changePct)}</div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
