import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold ' +
  'transition-colors duration-micro ease-standard ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
  'disabled:opacity-50 disabled:pointer-events-none';

const variants: Record<ButtonVariant, string> = {
  // primary brand action — teal fill (DESIGN-SYSTEM.md §1)
  primary: 'bg-teal text-white hover:opacity-90',
  outline: 'border border-teal text-teal hover:bg-teal hover:text-white',
  ghost: 'text-muted hover:bg-hover hover:text-text',
  // reserved for genuinely destructive actions, not sell-side market context
  danger: 'border border-down text-down hover:bg-down hover:text-white',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'text-xs px-3 py-1.5',
  md: 'text-sm px-4 py-2',
};

/**
 * The button style recipe, exported so non-button elements (e.g. a Next.js
 * `<Link>`) can be styled identically WITHOUT duplicating the class set —
 * `<Link className={buttonClasses({ variant: 'outline' })}>`. This keeps the
 * design system framework-agnostic (no next/link dependency in the package).
 */
export function buttonClasses(opts?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}): string {
  const { variant = 'primary', size = 'md', className } = opts ?? {};
  return cn(base, variants[variant], sizes[size], className);
}

/**
 * Button — the design-system button primitive. Faithful to the canonical
 * terminal's button styling (radius 8, teal actions) with proper keyboard
 * focus states (accessibility §5). forwardRef so it composes with menus/tooltips.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClasses({ variant, size, className })}
      {...props}
    />
  );
});
