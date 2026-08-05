'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tradew/ui';
import { inr } from '@/lib/format';

export interface AreaChartPoint {
  dateKey: string;
  value: number;
}

const PAD = { top: 12, right: 8, bottom: 20, left: 8 };

/**
 * Portfolio Value chart — single series, hand-rolled SVG (no charting
 * library in this repo, see TradeChart/Sparkline). Single series needs no
 * legend (dataviz skill, check 6) — the title above it already names it.
 * `prevClose` renders as a dashed reference line, matching the reference
 * screenshot. Positive/negative tone follows the up/down tokens, reserved in
 * this design system strictly for market-direction (tailwind-preset.ts).
 */
export function AreaChart({
  points,
  prevClose,
  width = 640,
  height = 220,
  fixedHeight = false,
}: {
  points: AreaChartPoint[];
  prevClose?: number;
  width?: number;
  /** SVG viewBox height. By default the chart scales proportionally to its
   *  container's width (only the width:height RATIO matters for the
   *  rendered shape), so the SAME `height` renders a different actual pixel
   *  height at every container width — pass `fixedHeight` when that's a
   *  problem. */
  height?: number;
  /** When true, the SVG fills exactly `height`px regardless of the
   *  width:height viewBox ratio (`preserveAspectRatio="none"`), instead of
   *  scaling proportionally with container width. Needed wherever this chart
   *  must match another fixed-pixel-height chart component exactly (e.g.
   *  MarketOverview's Line/Candles toggle against `TradeChart`, which always
   *  renders at a literal pixel height). */
  fixedHeight?: boolean;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { path, areaPath, scaleX, scaleY, min, max } = useMemo(() => {
    if (points.length === 0) {
      return { path: '', areaPath: '', scaleX: () => 0, scaleY: () => 0, min: 0, max: 0 };
    }
    const values = points.map((p) => p.value);
    const min = Math.min(...values, prevClose ?? Infinity);
    const max = Math.max(...values, prevClose ?? -Infinity);
    const span = max - min || 1;
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const scaleX = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const scaleY = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH;

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(p.value)}`).join(' ');
    const area = `${line} L ${scaleX(points.length - 1)} ${PAD.top + innerH} L ${scaleX(0)} ${PAD.top + innerH} Z`;
    return { path: line, areaPath: area, scaleX, scaleY, min, max };
  }, [points, prevClose, width, height]);

  if (points.length === 0) {
    return <div className="flex h-[220px] items-center justify-center text-xs text-faint">No data for this range yet</div>;
  }

  const last = points[points.length - 1];
  const up = prevClose == null || last.value >= prevClose;
  const hovered = hoverIdx != null ? points[hoverIdx] : null;

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const innerW = width - PAD.left - PAD.right;
    const ratio = Math.min(1, Math.max(0, (x - PAD.left) / innerW));
    setHoverIdx(Math.round(ratio * (points.length - 1)));
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio={fixedHeight ? 'none' : undefined}
        className="w-full"
        style={fixedHeight ? { height } : undefined}
        role="img"
        aria-label="Portfolio value over time"
      >
        <defs>
          <linearGradient id="portfolio-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className={up ? 'text-up' : 'text-down'} stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="100%" className={up ? 'text-up' : 'text-down'} stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>

        {prevClose != null && (
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={scaleY(prevClose)}
            y2={scaleY(prevClose)}
            className="text-border2"
            stroke="currentColor"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        )}

        <path d={areaPath} fill="url(#portfolio-area-fill)" />
        <path d={path} fill="none" className={up ? 'text-up' : 'text-down'} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

        {hovered && (
          <>
            <line
              x1={scaleX(hoverIdx!)}
              x2={scaleX(hoverIdx!)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              className="text-border2"
              stroke="currentColor"
              strokeWidth={1}
            />
            <circle cx={scaleX(hoverIdx!)} cy={scaleY(hovered.value)} r={4} className={up ? 'text-up' : 'text-down'} fill="currentColor" />
          </>
        )}

        <rect
          x={PAD.left}
          y={0}
          width={width - PAD.left - PAD.right}
          height={height}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
        />
      </svg>

      <div className="mt-1 flex justify-between text-[10px] text-faint">
        <span>{points[0].dateKey}</span>
        <span>{points[points.length - 1].dateKey}</span>
      </div>

      {hovered && (
        <div
          className={cn(
            'pointer-events-none absolute top-2 rounded-md border border-border2 bg-card px-2 py-1 text-[11px] shadow-card',
            hoverIdx! > points.length / 2 ? 'right-2' : 'left-2',
          )}
        >
          <div className="font-semibold text-text">{hovered.dateKey}</div>
          <div className="font-mono tabular-nums text-muted">{inr(hovered.value, 2)}</div>
        </div>
      )}
    </div>
  );
}
