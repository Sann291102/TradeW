'use client';

import { useId } from 'react';
import { cn } from '../lib/cn';

export interface SparklineProps {
  data: number[];
  /** Direction color; defaults to auto (last vs first). */
  tone?: 'up' | 'down' | 'auto';
  width?: number;
  height?: number;
  className?: string;
  'aria-label'?: string;
}

/**
 * Sparkline — inline mini trend chart with no axes (DESIGN-SYSTEM.md §4:
 * "Sparkline row"). Pure SVG, no chart lib — cheap enough to render per
 * watchlist/holding row. Color encodes direction only.
 */
export function Sparkline({
  data,
  tone = 'auto',
  width = 72,
  height = 24,
  className,
  'aria-label': ariaLabel,
}: SparklineProps) {
  const gradId = useId();
  if (data.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden="true" />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((d, i) => {
    const x = i * stepX;
    const y = height - ((d - min) / range) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const dir = tone === 'auto' ? (data[data.length - 1] >= data[0] ? 'up' : 'down') : tone;
  const stroke = dir === 'up' ? 'var(--green)' : 'var(--red)';
  const areaPath = `M0,${height} L${points.join(' L')} L${width},${height} Z`;
  const linePath = `M${points.join(' L')}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={ariaLabel ?? `trend ${dir}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
