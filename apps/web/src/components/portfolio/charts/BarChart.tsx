'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tradew/ui';
import { inr, sign } from '@/lib/format';

export interface BarChartPoint {
  label: string;
  value: number;
}

const HEIGHT = 180;
const PAD = { top: 10, right: 8, bottom: 20, left: 8 };
/** 4px rounded data-ends anchored to the baseline, per the dataviz skill's
 *  mark spec — never a fully-rounded pill for a bar. */
const BAR_RADIUS = 4;

/**
 * Diverging bar chart for Daily P&L / Monthly Returns — positive bars in the
 * `up` token, negative in `down`, both reserved strictly for market direction
 * in this design system (tailwind-preset.ts). A single measure diverging
 * around zero needs no legend (the sign is the encoding) and no second hue.
 */
export function BarChart({ points, valueFormat = 'currency', width = 640 }: { points: BarChartPoint[]; valueFormat?: 'currency' | 'percent'; width?: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { bars, scaleY, zeroY } = useMemo(() => {
    if (points.length === 0) return { bars: [], scaleY: () => 0, zeroY: 0 };
    const values = points.map((p) => p.value);
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const innerW = width - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const barW = Math.min(28, (innerW / points.length) * 0.6);
    const gap = innerW / points.length;
    const scaleY = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH;
    const zeroY = scaleY(0);

    const bars = points.map((p, i) => {
      const x = PAD.left + gap * i + gap / 2 - barW / 2;
      const y = Math.min(scaleY(p.value), zeroY);
      const h = Math.max(1, Math.abs(scaleY(p.value) - zeroY));
      return { ...p, x, y, w: barW, h };
    });
    return { bars, scaleY, zeroY };
  }, [points, width]);

  if (points.length === 0) {
    return <div className="flex h-[180px] items-center justify-center text-xs text-faint">No data for this range yet</div>;
  }

  const hovered = hoverIdx != null ? bars[hoverIdx] : null;
  const fmt = (v: number) => (valueFormat === 'percent' ? `${sign(v)}${Math.abs(v).toFixed(2)}%` : `${sign(v)}${inr(Math.abs(v), 2)}`);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="w-full" role="img" aria-label="Bar chart">
        <line x1={PAD.left} x2={width - PAD.right} y1={zeroY} y2={zeroY} className="text-border2" stroke="currentColor" strokeWidth={1} />
        {bars.map((b, i) => (
          <rect
            key={b.label}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={BAR_RADIUS}
            className={cn(b.value >= 0 ? 'text-up' : 'text-down', hoverIdx === i ? 'opacity-100' : 'opacity-90')}
            fill="currentColor"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          />
        ))}
      </svg>

      <div className="mt-1 flex justify-between text-[10px] text-faint">
        {bars.length <= 8 ? (
          bars.map((b) => (
            <span key={b.label} className="truncate">
              {b.label}
            </span>
          ))
        ) : (
          <>
            <span>{points[0].label}</span>
            <span>{points[points.length - 1].label}</span>
          </>
        )}
      </div>

      {hovered && (
        <div
          className={cn(
            'pointer-events-none absolute top-2 rounded-md border border-border2 bg-card px-2 py-1 text-[11px] shadow-card',
            hoverIdx! > bars.length / 2 ? 'right-2' : 'left-2',
          )}
        >
          <div className="font-semibold text-text">{hovered.label}</div>
          <div className={cn('font-mono tabular-nums', hovered.value >= 0 ? 'text-up' : 'text-down')}>{fmt(hovered.value)}</div>
        </div>
      )}
    </div>
  );
}
