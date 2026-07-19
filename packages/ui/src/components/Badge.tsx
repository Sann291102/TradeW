import { type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Semantic tones. `positive`/`negative` are the ONLY market-direction colors
 * and must be used strictly for gains/losses/sentiment, never decoratively
 * (DESIGN-SYSTEM.md §1). `neutral`/`brand`/`warning` cover everything else.
 */
export type BadgeTone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-hover text-muted border border-border2',
  brand: 'bg-teal-bg text-teal border border-teal',
  positive: 'bg-up-bg text-up border border-up',
  negative: 'bg-down-bg text-down border border-down',
  warning: 'bg-amber-bg text-amber border border-amber',
};

/**
 * Badge / Pill — the small rounded, color-mapped pill from the component
 * inventory (DESIGN-SYSTEM.md §4): sentiment tags, trap labels ("Bear Trap"),
 * journal moods, category chips. Color always encodes meaning, never decoration.
 */
export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5',
        'text-[11px] font-bold leading-tight whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
