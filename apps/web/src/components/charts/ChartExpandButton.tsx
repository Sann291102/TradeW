'use client';

import { cn } from '@tradew/ui';
import { CloseIcon, ExpandIcon } from '../shell/icons';

/**
 * Full-screen toggle for a chart, pinned to the chart's bottom-right corner.
 *
 * Bottom-right rather than in the panel header because that is where every
 * charting package puts it (TradingView, Dhan, the broker terminals) — it is
 * the one control traders reach for without looking, and it was previously a
 * small icon buried in the header row where it went unnoticed.
 *
 * Shared so every chart surface gets the same affordance in the same place:
 * the terminal chart, the crypto board, and any market chart added later.
 * Absolutely positioned, so the parent needs `relative`.
 */
export function ChartExpandButton({
  expanded,
  onToggle,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={expanded ? 'Exit full screen' : 'Full screen chart'}
      title={expanded ? 'Exit full screen' : 'Full screen chart'}
      className={cn(
        'absolute bottom-2 right-2 z-20 flex h-8 w-8 items-center justify-center rounded-lg',
        'border border-border2 bg-card/90 text-muted backdrop-blur-sm',
        'transition-colors duration-micro hover:text-text hover:border-teal',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        className,
      )}
    >
      {expanded ? <CloseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
    </button>
  );
}
