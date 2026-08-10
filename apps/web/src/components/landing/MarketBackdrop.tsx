'use client';

import { motion, useReducedMotion } from 'framer-motion';

/**
 * Ambient market backdrop for the hero — a faint grid, drifting candles and
 * two slow price waves.
 *
 * Two rules shaped this:
 *  - Green/red are the only decorative-looking colours used here, and they are
 *    legitimate: each candle encodes a direction, which is exactly what
 *    DESIGN-SYSTEM.md §1 reserves `up`/`down` for. Nothing else on this page
 *    uses them.
 *  - Positions are a fixed table rather than random, so server and client
 *    render byte-identical markup. Randomising here is the classic way to
 *    introduce a hydration mismatch in an SSR app.
 */

const CANDLES = [
  { x: 6, y: 16, h: 46, dir: 'up' as const, delay: 0 },
  { x: 17, y: 52, h: 62, dir: 'down' as const, delay: 1.4 },
  { x: 28, y: 30, h: 38, dir: 'down' as const, delay: 2.6 },
  { x: 39, y: 66, h: 54, dir: 'up' as const, delay: 0.7 },
  { x: 52, y: 24, h: 44, dir: 'down' as const, delay: 3.1 },
  { x: 63, y: 58, h: 58, dir: 'up' as const, delay: 1.9 },
  { x: 74, y: 34, h: 40, dir: 'down' as const, delay: 2.2 },
  { x: 85, y: 62, h: 50, dir: 'up' as const, delay: 0.4 },
  { x: 94, y: 28, h: 42, dir: 'up' as const, delay: 3.6 },
];

export function MarketBackdrop() {
  const reduce = useReducedMotion();

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* Grid — masked so it fades out toward the edges instead of ending on a
          hard line against the page background. */}
      <div
        className="absolute inset-0 opacity-[0.28]"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 75% 62% at 50% 42%, #000 45%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 75% 62% at 50% 42%, #000 45%, transparent 100%)',
        }}
      />

      {/* Teal wash behind the headline */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 50% 28%, var(--teal-bg), transparent 70%)',
          opacity: 0.55,
        }}
      />

      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {CANDLES.map((c, i) => (
          <motion.g
            key={i}
            initial={reduce ? undefined : { opacity: 0 }}
            animate={reduce ? undefined : { opacity: [0, 0.5, 0.5, 0], y: [4, 0, 0, -4] }}
            transition={{
              duration: 11,
              repeat: Infinity,
              delay: c.delay,
              ease: 'easeInOut',
              times: [0, 0.18, 0.82, 1],
            }}
            opacity={reduce ? 0.32 : undefined}
          >
            {/* wick */}
            <rect
              x={c.x + 0.32}
              y={c.y - c.h * 0.16}
              width="0.14"
              height={c.h * 0.14 * 2 + c.h * 0.1}
              fill={c.dir === 'up' ? 'var(--green)' : 'var(--red)'}
              vectorEffect="non-scaling-stroke"
            />
            {/* body */}
            <rect
              x={c.x}
              y={c.y}
              width="0.78"
              height={c.h * 0.1}
              rx="0.12"
              fill={c.dir === 'up' ? 'var(--green)' : 'var(--red)'}
            />
          </motion.g>
        ))}
      </svg>

      {/* Price waves — two out-of-phase sine paths drifting horizontally.
          Translating a path that is twice the viewport width gives a seamless
          loop without re-drawing geometry each frame. */}
      <svg
        className="absolute bottom-0 left-0 h-[38%] w-[200%]"
        viewBox="0 0 200 40"
        preserveAspectRatio="none"
      >
        <motion.path
          d="M0 26 C 12 16, 24 34, 38 26 S 62 14, 76 24 S 100 34, 114 24 S 138 14, 152 24 S 176 34, 200 22"
          fill="none"
          stroke="var(--teal)"
          strokeWidth="0.4"
          opacity="0.4"
          animate={reduce ? undefined : { x: [0, -100] }}
          transition={{ duration: 34, repeat: Infinity, ease: 'linear' }}
        />
        <motion.path
          d="M0 32 C 14 24, 26 38, 40 32 S 64 22, 80 30 S 104 38, 120 30 S 144 22, 160 30 S 184 38, 200 30"
          fill="none"
          stroke="var(--teal)"
          strokeWidth="0.3"
          opacity="0.22"
          animate={reduce ? undefined : { x: [0, -100] }}
          transition={{ duration: 52, repeat: Infinity, ease: 'linear' }}
        />
      </svg>

      {/* Fade the whole backdrop into the page background at the bottom edge */}
      <div
        className="absolute inset-x-0 bottom-0 h-40"
        style={{ background: 'linear-gradient(to bottom, transparent, var(--bg))' }}
      />
    </div>
  );
}
