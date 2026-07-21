import Link from 'next/link';
import { Card, Surface, cn } from '@tradew/ui';
import { SECTORS } from '@/lib/mock/market';
import { pct } from '@/lib/format';

/**
 * SectorHeatmap — the "Sector Heatmap" tiles from the canonical home. Tile
 * intensity encodes magnitude, hue encodes direction (green up / red down) —
 * market-direction color only. Independent widget (Step 5).
 *
 * Each tile links to `/markets?sector=<key>` (Stocks tab, filtered to that
 * sector's constituents — see `SECTOR_STOCKS` in lib/mock/market.ts) and
 * uses the same `Surface interactive` hover-lift as the index cards
 * (`IndexOverview.tsx`), so hovering a sector behaves like hovering an index.
 */
export function SectorHeatmap() {
  return (
    <Card title="Sector Heatmap">
      <div className="grid grid-cols-3 gap-1.5">
        {SECTORS.map((s) => {
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
