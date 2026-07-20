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
    // v2 — mirrors --dur-tick in tokens.css; used for the brief color flash on
    // a live value change, NOT for animating the digits themselves (ticks
    // still update in place per §8 below — speed-to-information over polish).
    tick: 0.6,
  },
  ease: {
    standard: [0.4, 0, 0.2, 1] as [number, number, number, number],
    // v2 — mirrors --ease-spring; overshoot curve for magnetic/lift interactions.
    spring: [0.34, 1.56, 0.64, 1] as [number, number, number, number],
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

/* ============================================================================
 * v2 additions (Phase 1 redesign) — additive only, nothing above is renamed
 * or removed. Same rules apply: motion communicates state, it never gates an
 * action, and reduced-motion must still degrade to instant.
 * ==========================================================================*/

const spring: Transition = {
  duration: motionTokens.duration.micro,
  ease: motionTokens.ease.spring,
};

/** whileHover/whileTap props for buttons/icon-buttons that should feel "magnetic". */
export const magneticHover = { scale: 1.03, transition: spring };
export const magneticTap = { scale: 0.97, transition: { duration: 0.1, ease: motionTokens.ease.standard } };

/** whileHover prop for `Surface`'s `interactive` mode — lift + deepen shadow. */
export const cardHoverLift = {
  y: -4,
  boxShadow: 'var(--elev-4)',
  transition: spring,
};

/**
 * Larger-travel staggered entrance for section-level grids (e.g. the Market
 * Workspace). The existing `staggerContainer`/`listItem` stay as-is for dense
 * feeds (watchlists, observation lists) — this is for fewer, bigger cards.
 */
export const staggerContainerSlow: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

export const cardEntrance: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: standard },
};

/** Richer page/workspace transition than the bare route fade — optional upgrade for AppFrame. */
export const workspaceTransition: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.995 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { ...standard, duration: motionTokens.duration.route } },
  exit: { opacity: 0, y: 8, transition: { duration: motionTokens.duration.micro, ease: motionTokens.ease.standard } },
};

/** Crossfade pair for morphing a `Skeleton` into its loaded content. */
export const skeletonToContent = {
  skeleton: { opacity: 1, transition: { duration: motionTokens.duration.micro } },
  content: { opacity: [0, 1], transition: standard },
};

/** Enter/layout/exit choreography for `NotificationCenter` toasts. */
export const toastChoreography: Variants = {
  hidden: { opacity: 0, y: -8, scale: 0.96 },
  visible: { opacity: 1, y: 0, scale: 1, transition: spring },
  exit: { opacity: 0, x: 32, transition: { duration: motionTokens.duration.micro, ease: motionTokens.ease.standard } },
};

/**
 * Background-tint pulse for a live value change — the flash IS the animation;
 * the number itself updates in place with no digit count-up (TRADEW-OS.md §8:
 * "speed-to-information is the product's core metric"). `tone` picks the
 * flash color; consumers (e.g. `AnimatedNumber`) trigger this via `animate`
 * keyed on the value, not via `whileHover`/mount.
 */
export function priceFlash(tone: 'up' | 'down'): Variants {
  const glow = tone === 'up' ? 'var(--green-bg)' : 'var(--red-bg)';
  return {
    idle: { backgroundColor: 'rgba(0,0,0,0)' },
    flash: {
      backgroundColor: [glow, 'rgba(0,0,0,0)'],
      transition: { duration: motionTokens.duration.tick, ease: motionTokens.ease.standard },
    },
  };
}

/**
 * Returns instant (zero-duration, no offset) variants when `reduce` is true —
 * so consumers don't hand-write the `useReducedMotion()` guard on every call
 * site. Strips transitions and collapses hidden/visible to the same resting
 * position; `exit` becomes an instant opacity drop.
 */
export function withReducedMotion(variants: Variants, reduce: boolean): Variants {
  if (!reduce) return variants;
  const instant = { duration: 0 };
  const rest = (variants.visible as Record<string, unknown>) ?? {};
  return {
    hidden: { ...rest, transition: instant },
    visible: { ...rest, transition: instant },
    ...(variants.exit ? { exit: { opacity: 0, transition: instant } } : {}),
  };
}
