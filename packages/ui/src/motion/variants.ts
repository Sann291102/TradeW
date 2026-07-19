import type { Transition, Variants } from 'framer-motion';

/**
 * Shared Framer Motion tokens & variants — the single source of motion timing
 * for the whole platform (GENESIS-V2-BLUEPRINT.md §3, TRADEW-OS.md §8).
 *
 * Durations are in SECONDS (framer-motion's unit), mirroring the CSS ms tokens
 * in tokens.css: micro ≤150ms, panel 200–300ms, route ≤350ms. Motion
 * communicates state change — it never gates an action and never decorates.
 *
 * Reduced motion: components should read `useReducedMotion()` from framer-motion
 * and skip/instant these where appropriate; the CSS token layer already zeroes
 * its own durations under prefers-reduced-motion.
 */
export const motionTokens = {
  duration: {
    micro: 0.15,
    panel: 0.25,
    route: 0.3,
  },
  ease: {
    standard: [0.4, 0, 0.2, 1] as [number, number, number, number],
  },
} as const;

const standard: Transition = {
  duration: motionTokens.duration.panel,
  ease: motionTokens.ease.standard,
};

/** Card / content enter — mirrors the canonical `.fade` keyframe (fade + 4px rise). */
export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: standard },
  exit: { opacity: 0, y: 4, transition: { ...standard, duration: motionTokens.duration.micro } },
};

/** Plain fade — tooltips, subtle swaps. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: motionTokens.duration.micro, ease: motionTokens.ease.standard } },
  exit: { opacity: 0, transition: { duration: motionTokens.duration.micro, ease: motionTokens.ease.standard } },
};

/** Docked right-side panel (TradeW AI dock) / drawer slide-in. */
export const panelSlide: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: standard },
  exit: { opacity: 0, x: 24, transition: standard },
};

/** Sidebar expand/collapse and left-edge drawers. */
export const sidebarSlide: Variants = {
  hidden: { opacity: 0, x: -16 },
  visible: { opacity: 1, x: 0, transition: standard },
  exit: { opacity: 0, x: -16, transition: standard },
};

/** Modal/dialog enter — slight scale + fade. */
export const modalPop: Variants = {
  hidden: { opacity: 0, scale: 0.98, y: 6 },
  visible: { opacity: 1, scale: 1, y: 0, transition: standard },
  exit: { opacity: 0, scale: 0.98, y: 6, transition: { ...standard, duration: motionTokens.duration.micro } },
};

/**
 * Staggered list container + item — for watchlists, feeds, tables appearing.
 * Row-level updates (live ticks) do NOT use this; ticks update in place with no
 * animated count-up (TRADEW-OS.md §8).
 */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03 } },
};

export const listItem: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: motionTokens.duration.micro, ease: motionTokens.ease.standard } },
};
