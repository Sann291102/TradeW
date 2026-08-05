'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Card, Surface, cn } from '@tradew/ui';
import { SECTORS, SECTOR_STOCKS, type SectorTile } from '@/lib/mock/market';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { pct } from '@/lib/format';

/**
 * SectorHeatmap — tile intensity encodes magnitude, hue encodes direction
 * (green up / red down), market-direction color only.
 *
 * Previously always the static `SECTORS` mock. There's no per-sector
 * aggregate endpoint, but every `SECTOR_STOCKS` constituent symbol IS covered
 * by the live Dhan feed (same universe `MarketMovers` ranks) — so each tile's
 * `changePct` is now the real average across its live constituents when the
 * feed is reachable, falling back to the mock tiles otherwise.
 */
export function SectorHeatmap() {
  const { stocks, status } = useDhanLiveFeed();
  const live = (status === 'live' || status === 'closed') && !!stocks && stocks.length > 0;

  const tiles: SectorTile[] = useMemo(() => {
    if (!live) return SECTORS;
    const bySymbol = new Map(stocks!.map((q) => [q.symbol, q.changePct]));
    return SECTORS.map((s) => {
      const constituents = SECTOR_STOCKS[s.key] ?? [];
      const matched = constituents.map((c) => bySymbol.get(c.symbol)).filter((v): v is number => v != null);
      if (matched.length === 0) return s;
      const avg = matched.reduce((sum, v) => sum + v, 0) / matched.length;
      return { ...s, changePct: Number(avg.toFixed(2)) };
    });
  }, [live, stocks]);

  return (
    <Card title="Sector Heatmap" className="flex h-full flex-col">
      <div className="grid grid-cols-3 content-start gap-1.5">
        {tiles.map((s) => {
          const up = s.changePct >= 0;
          const intensity = Math.min(1, Math.abs(s.changePct) / 1.2);
          const bg = up
            ? `rgba(38,166,154,${0.18 + intensity * 0.55})`
            : `rgba(239,83,80,${0.18 + intensity * 0.55})`;
          return (
            <Link key={s.key} href={`/markets?sector=${s.key}`}>
              <Surface
                elevation={0}
                interactive
                className="flex flex-col items-center justify-center rounded-md px-2 py-3 text-center"
                style={{ background: bg }}
              >
                <div className="text-[11px] font-bold text-text">{s.name}</div>
                <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                  {pct(s.changePct)}
                </div>
              </Surface>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
