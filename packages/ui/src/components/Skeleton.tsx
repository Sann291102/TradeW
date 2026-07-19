import { type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Skeleton — loading placeholder (DESIGN-SYSTEM.md skeleton loaders; used above
 * ~150ms latency instead of a spinner, keeping layout stable). Pulse honors
 * prefers-reduced-motion via Tailwind's motion-safe.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('motion-safe:animate-pulse rounded-md bg-border2/60', className)}
      {...props}
    />
  );
}
