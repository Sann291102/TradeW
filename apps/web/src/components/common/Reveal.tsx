'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Scroll reveal for marketing surfaces.
 *
 * Lifted from the rules `components/landing/LandingPage.tsx` arrived at the
 * hard way — that file keeps its own private copy, deliberately left untouched
 * here (a marketing page is not the place to find out a shared refactor
 * regressed). Every guarantee below cost a real blank-page bug, so they are
 * restated rather than re-derived:
 *
 * 1. IntersectionObserver, not framer's `whileInView`. `whileInView` does not
 *    fire for an element already intersecting at mount — which is exactly what
 *    happens on a deep link — leaving opacity pinned at 0 forever.
 * 2. `initial={false}`. `initial={{ opacity: 0 }}` is what the SERVER
 *    serialises, shipping every section as `style="opacity:0"` and making the
 *    page depend on hydration to be VISIBLE. Motion may only ever add to
 *    markup that already reads.
 * 3. The element type never changes across states. Swapping <div> → motion.div
 *    after hydration detaches the observed node, so it can never intersect and
 *    everything below the fold stays hidden permanently.
 *
 * A decorative animation must never be the reason a control is unreachable —
 * on this page that control is a Checkout button.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'ssr' | 'hidden' | 'shown'>('ssr');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) {
      setState('shown');
      return;
    }

    setState('hidden');
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry!.isIntersecting) {
          setState('shown');
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={false}
      animate={state === 'hidden' ? { opacity: 0, y: 16 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.4, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
