import { forwardRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '../lib/cn';
import { cardHoverLift } from '../motion/variants';

export type SurfaceElevation = 0 | 1 | 2 | 3 | 4;

export const ELEVATION_SHADOW: Record<SurfaceElevation, string> = {
  0: 'shadow-none',
  1: 'shadow-elev1',
  2: 'shadow-elev2',
  3: 'shadow-elev3',
  4: 'shadow-elev4',
};

export interface SurfaceProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  /** Progressive shadow ramp (glass + elevation hierarchy). Default 2. */
  elevation?: SurfaceElevation;
  /** Translucent + blurred surface using the `--card-glass` tokens instead of
   *  solid `--card`. Degrades to solid automatically in the high-contrast
   *  theme (tokens.css handles this — no branching needed here). */
  glass?: boolean;
  /** Lifts one elevation + deepens shadow on hover, via the shared
   *  `cardHoverLift` spring variant. Off by default (most Surfaces are static). */
  interactive?: boolean;
  children?: ReactNode;
}

/**
 * Surface — the base glass/elevation primitive new Phase 1 UI composes on top
 * of (Market Workspace section cards, Sentinel surfaces). Distinct from
 * `Card`: no built-in header row, just the elevation/glass treatment, so it
 * can wrap arbitrary layouts. `Card`/`Panel` can opt into `elevation`/`glass`
 * themselves rather than every consumer switching to `Surface` directly.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { elevation = 2, glass = false, interactive = false, className, children, ...props },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      className={cn(
        'rounded-card border',
        glass
          ? 'border-glassBorder bg-cardGlass backdrop-blur-glass'
          : 'border-border bg-card',
        ELEVATION_SHADOW[elevation],
        interactive && 'cursor-pointer',
        className,
      )}
      whileHover={interactive ? cardHoverLift : undefined}
      {...props}
    >
      {children}
    </motion.div>
  );
});
