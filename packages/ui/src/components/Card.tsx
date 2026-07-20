import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { ELEVATION_SHADOW, type SurfaceElevation } from './Surface';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Optional header row title (renders the canonical `h2` treatment).
   *  Omits the native string-only `title` attribute so this can be rich content. */
  title?: ReactNode;
  /** Small muted sub-label beside the title (canonical `h2 small`). */
  subtitle?: ReactNode;
  /** Optional leading icon in the header row. */
  icon?: ReactNode;
  /** Optional right-aligned header actions. */
  actions?: ReactNode;
  /** v2: opt into the elevation ramp instead of the default single
   *  `--shadow`. Omit to keep existing behavior unchanged. */
  elevation?: SurfaceElevation;
  /** v2: opt into a translucent/blurred glass surface instead of solid
   *  `--card`. Omit to keep existing behavior unchanged. */
  glass?: boolean;
}

/**
 * Card — the bordered, rounded dark-surface panel from the canonical `.card`
 * rule (bg-card, 1px border, radius 12, 16/18 padding) and DESIGN-SYSTEM.md §4.
 * Header row (icon + title + subtitle + actions) is optional; passing none
 * renders a plain surface.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, subtitle, icon, actions, elevation, glass = false, className, children, ...props },
  ref,
) {
  const hasHeader = title != null || icon != null || actions != null;
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-card border px-[18px] py-4',
        'transition-colors duration-panel ease-standard',
        glass ? 'border-glassBorder bg-cardGlass backdrop-blur-glass' : 'bg-card border-border',
        elevation != null ? ELEVATION_SHADOW[elevation] : 'shadow-card',
        className,
      )}
      {...props}
    >
      {hasHeader && (
        <div className="mb-3 flex items-center gap-2">
          {icon && <span className="text-teal shrink-0">{icon}</span>}
          {title != null && (
            <h2 className="text-base font-semibold leading-tight">
              {title}
              {subtitle != null && (
                <small className="ml-2 text-xs font-normal text-faint">{subtitle}</small>
              )}
            </h2>
          )}
          {actions != null && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
});
