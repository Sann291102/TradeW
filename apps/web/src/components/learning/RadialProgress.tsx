'use client';

import { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@tradew/ui';

export interface RadialProgressProps {
  /** 0-100. Values outside this range are clamped. */
  value: number;
  size?: number;
  strokeWidth?: number;
  trackColor?: string;
  fillColor?: string;
  className?: string;
  children?: React.ReactNode;
  'aria-label'?: string;
}

/**
 * RadialProgress — pure-SVG donut/ring progress meter, matching the app's
 * existing "no chart library" convention (see @tradew/ui's Sparkline). Value
 * animates in on mount via strokeDashoffset; respects prefers-reduced-motion.
 */
export function RadialProgress({
  value,
  size = 132,
  strokeWidth = 12,
  trackColor = 'var(--border2)',
  fillColor = 'var(--teal)',
  className,
  children,
  'aria-label': ariaLabel,
}: RadialProgressProps) {
  const gradId = useId();
  const reduce = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel ?? `${Math.round(clamped)}% complete`}
        className="-rotate-90"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={fillColor} stopOpacity="0.75" />
            <stop offset="100%" stopColor={fillColor} stopOpacity="1" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: reduce ? offset : circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: reduce ? 0 : 0.9, ease: [0.4, 0, 0.2, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center rotate-0">{children}</div>
    </div>
  );
}
