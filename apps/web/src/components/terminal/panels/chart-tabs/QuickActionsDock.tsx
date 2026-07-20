'use client';

import { motion, type Variants } from 'framer-motion';
import { cn, Surface, magneticHover, magneticTap } from '@tradew/ui';

export interface QuickAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  tone?: 'up' | 'down' | 'neutral' | 'teal';
  active?: boolean;
}

const dockVariants: Variants = {
  hidden: { opacity: 0, scale: 0.92, y: 2 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 420, damping: 28 } },
};

const TONE_CLASS: Record<NonNullable<QuickAction['tone']>, string> = {
  up: 'text-up hover:bg-up-bg',
  down: 'text-down hover:bg-down-bg',
  neutral: 'text-muted hover:bg-hover hover:text-text',
  teal: 'text-teal hover:bg-teal-bg',
};

/**
 * QuickActionsDock — the floating hover/focus action row for an Option Chain
 * leg (Buy/Sell/Chart/Analyze/Watchlist/Strategy). Purely presentational:
 * the parent controls visibility (hover/focus/tap) and passes real
 * `onClick` handlers — this component doesn't know about routing, stores,
 * or business logic.
 */
export function QuickActionsDock({ visible, actions }: { visible: boolean; actions: QuickAction[] }) {
  return (
    <motion.div
      initial="hidden"
      animate={visible ? 'visible' : 'hidden'}
      variants={dockVariants}
      className={cn('absolute inset-0 z-10 flex items-center justify-center', !visible && 'pointer-events-none')}
    >
      <Surface glass elevation={3} className="flex items-center gap-0.5 rounded-full px-1 py-1">
        {actions.map((a) => (
          <motion.button
            key={a.key}
            type="button"
            aria-label={a.label}
            aria-pressed={a.active}
            title={a.label}
            onClick={(e) => {
              e.stopPropagation();
              a.onClick();
            }}
            whileHover={magneticHover}
            whileTap={magneticTap}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors duration-micro',
              TONE_CLASS[a.tone ?? 'neutral'],
              a.active && 'bg-teal-bg text-teal',
            )}
          >
            {a.icon}
          </motion.button>
        ))}
      </Surface>
    </motion.div>
  );
}
