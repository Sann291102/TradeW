import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';
import { ELEVATION_SHADOW, type SurfaceElevation } from './Surface';

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  /** Small muted sub-label beside the title. */
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Show a skeleton body instead of children. */
  loading?: boolean;
  /** Show an empty-state body instead of children. */
  empty?: boolean;
  emptyLabel?: ReactNode;
  /** Body scrolls independently; header stays pinned. */
  scroll?: boolean;
  bodyClassName?: string;
  /** Dock chrome (Milestone 3): hides the body, header stays visible — the
   *  panel keeps its slot but takes minimal vertical space. Distinct from
   *  `loading`/`empty`, which describe body CONTENT state, not visibility. */
  collapsed?: boolean;
  /** v2: opt into the elevation ramp instead of the default single
   *  `--shadow`. Omit to keep existing behavior unchanged. */
  elevation?: SurfaceElevation;
  /** v2: opt into a translucent/blurred glass surface instead of solid
   *  `--card`. Omit to keep existing behavior unchanged. */
  glass?: boolean;
}

/**
 * Panel — a terminal workspace slot (chart, orders, positions, depth, news…).
 * Distinct from Card: full-height flex column with a pinned header bar and an
 * independently-scrolling body, so the terminal grid can pack many panels
 * (DESIGN-SYSTEM.md §3–4; the trading-workspace slots in TRADEW-OS.md §5).
 * Business logic is NOT implemented here — a panel renders whatever body it's
 * given, or its loading/empty states.
 */
export function Panel({
  title,
  subtitle,
  icon,
  actions,
  loading = false,
  empty = false,
  emptyLabel = 'No data yet',
  scroll = true,
  bodyClassName,
  collapsed = false,
  elevation,
  glass = false,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <section
      aria-expanded={!collapsed}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-card border',
        glass ? 'border-glassBorder bg-cardGlass backdrop-blur-glass' : 'bg-card border-border',
        elevation != null ? ELEVATION_SHADOW[elevation] : 'shadow-card',
        collapsed && 'flex-none',
        className,
      )}
      {...props}
    >
      {(title != null || actions != null || icon != null) && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          {icon && <span className="shrink-0 text-teal">{icon}</span>}
          {title != null && (
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted">
              {title}
              {subtitle != null && (
                <span className="ml-1.5 font-normal normal-case text-faint">{subtitle}</span>
              )}
            </h3>
          )}
          {actions != null && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}
      {!collapsed && (
        <div className={cn('min-h-0 flex-1 p-3', scroll && 'overflow-auto', bodyClassName)}>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : empty ? (
            <EmptyState title={emptyLabel} />
          ) : (
            children
          )}
        </div>
      )}
    </section>
  );
}
