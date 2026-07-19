import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only buttons must be labelled for screen readers (a11y §5). */
  'aria-label': string;
  active?: boolean;
}

/**
 * IconButton — square, icon-only control for the top bar / toolbars (bell,
 * theme, fullscreen, AI sparkle). `aria-label` is required by the type so an
 * unlabelled icon button can't ship.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, active, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'relative inline-flex h-9 w-9 items-center justify-center rounded-lg',
        'text-muted transition-colors duration-micro ease-standard',
        'hover:bg-hover hover:text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        'disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-teal-bg text-teal',
        className,
      )}
      {...props}
    />
  );
});
