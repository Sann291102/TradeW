'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, animate, useReducedMotion } from 'framer-motion';
import { cn } from '../lib/cn';
import { priceFlash, motionTokens } from '../motion/variants';

export interface AnimatedNumberProps {
  value: number;
  /** Defaults to en-IN grouping (matches the rest of the app's INR figures). */
  format?: (value: number) => string;
  className?: string;
  /** Flash up/down background tint on value change. Default true. */
  flashOnChange?: boolean;
  /**
   * Count up from 0 on first mount only (e.g. a portfolio hero number
   * revealing). Live tick updates AFTER mount are always instant, never
   * tweened — ticks update in place per TRADEW-OS.md §8 ("speed-to-information
   * is the product's core metric"); only the flash communicates the change.
   * Default false.
   */
  countUpOnMount?: boolean;
}

const defaultFormat = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/**
 * AnimatedNumber — the live-price/P&L primitive reused across the Market
 * Workspace, Ticker, and Portfolio surfaces. Deliberately does NOT tween the
 * digits between values on every tick (see `countUpOnMount` doc) — the only
 * per-tick animation is a brief up/down background flash via `priceFlash`.
 */
export function AnimatedNumber({
  value,
  format = defaultFormat,
  className,
  flashOnChange = true,
  countUpOnMount = false,
}: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  const prevRef = useRef(value);
  const mountedRef = useRef(false);
  const [display, setDisplay] = useState(countUpOnMount && !reduce ? 0 : value);
  const [tone, setTone] = useState<'idle' | 'flash'>('idle');
  const [flashTone, setFlashTone] = useState<'up' | 'down'>('up');

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = value;
      if (countUpOnMount && !reduce) {
        const controls = animate(0, value, {
          duration: motionTokens.duration.route,
          ease: motionTokens.ease.standard,
          onUpdate: setDisplay,
        });
        return () => controls.stop();
      }
      setDisplay(value);
      return;
    }

    const prev = prevRef.current;
    prevRef.current = value;
    setDisplay(value);
    if (flashOnChange && value !== prev && !reduce) {
      setFlashTone(value > prev ? 'up' : 'down');
      setTone('flash');
    }
  }, [value, countUpOnMount, reduce, flashOnChange]);

  return (
    <motion.span
      className={cn('inline-block rounded px-0.5 font-mono tabular-nums', className)}
      variants={priceFlash(flashTone)}
      animate={tone}
      onAnimationComplete={() => setTone('idle')}
    >
      {format(display)}
    </motion.span>
  );
}
