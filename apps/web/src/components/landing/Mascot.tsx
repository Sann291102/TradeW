'use client';

import { motion, useReducedMotion } from 'framer-motion';

/**
 * The TradeW AI mascot — the platform's agent identity.
 *
 * Rounded-cube head with a rotating candlestick "brain", glowing eyes, and
 * minimal hands working a small terminal. Drawn entirely from design tokens
 * (`--teal`, `--card`, `--border2`) rather than hard-coded hex, so it inherits
 * light / dark / high-contrast automatically like every other surface.
 *
 * Every animation is transform/opacity only (no layout-affecting properties)
 * and the whole thing goes static under `prefers-reduced-motion`.
 */
export function Mascot({ size = 160, className }: { size?: number; className?: string }) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      className={className}
      style={{ width: size, height: size }}
      animate={reduce ? undefined : { y: [0, -6, 0, -3, 0] }}
      transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 160 160" className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id="tw-mascot-head" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--card)" />
            <stop offset="100%" stopColor="var(--bg)" />
          </linearGradient>
          <linearGradient id="tw-mascot-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--card)" />
            <stop offset="100%" stopColor="var(--bg)" />
          </linearGradient>
          <radialGradient id="tw-mascot-eye">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="55%" stopColor="var(--teal)" />
            <stop offset="100%" stopColor="var(--teal)" />
          </radialGradient>
          <filter id="tw-mascot-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Contact shadow — grounds the mascot so it reads as floating above a
            surface rather than pasted onto one. Breathes with the float.
            Scaled via transform rather than by animating `rx`: animating SVG
            geometry attributes makes the browser re-resolve the length each
            frame (and framer-motion hands it an undefined initial value), so
            this stays transform/opacity-only like everything else here. */}
        <motion.ellipse
          cx="80"
          cy="150"
          rx="38"
          ry="5"
          fill="var(--teal)"
          style={{ transformOrigin: '80px 150px' }}
          animate={reduce ? undefined : { scaleX: [1, 0.86, 1], opacity: [0.16, 0.1, 0.16] }}
          initial={{ opacity: 0.16 }}
          transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Body and head. The rim is teal at low opacity rather than
            `--border2`: the chassis fill is card-on-bg, which is nearly the
            same value as the page behind it, so a neutral border leaves the
            silhouette invisible on the dark theme. A faint accent rim is what
            separates it from the background in both themes. */}
        <rect
          x="54"
          y="84"
          width="52"
          height="42"
          rx="16"
          fill="url(#tw-mascot-body)"
          stroke="var(--teal)"
          strokeOpacity="0.45"
        />

        <rect
          x="42"
          y="20"
          width="76"
          height="60"
          rx="19"
          fill="url(#tw-mascot-head)"
          stroke="var(--teal)"
          strokeOpacity="0.55"
        />

        {/* The candlestick "brain" — the signature mark. Two candles with wicks
            orbiting a centre point, visible through the head like a readout.
            Uses the teal accent, not up/down green-red: this is brand, not
            market direction (DESIGN-SYSTEM.md §1 reserves those). */}
        <g transform="translate(80 39)" opacity="0.9">
          <motion.g
            animate={reduce ? undefined : { rotate: 360 }}
            transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          >
            <line x1="-8" y1="-10" x2="-8" y2="10" stroke="var(--teal)" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
            <rect x="-11" y="-5" width="6" height="11" rx="2" fill="var(--teal)" />
            <line x1="8" y1="-10" x2="8" y2="10" stroke="var(--teal)" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
            <rect x="5" y="-7" width="6" height="9" rx="2" fill="var(--teal)" opacity="0.55" />
          </motion.g>
        </g>

        {/* Eyes — the blink is a scaleY pulse on a shared origin so both lids
            close together. Timing is deliberately irregular (two blinks per
            7s cycle, unevenly spaced) because evenly-spaced blinking reads
            as a loading spinner rather than as something alive. */}
        <motion.g
          filter="url(#tw-mascot-glow)"
          animate={reduce ? undefined : { scaleY: [1, 1, 0.12, 1, 1, 1, 0.12, 1, 1] }}
          transition={{
            duration: 7,
            repeat: Infinity,
            times: [0, 0.26, 0.29, 0.32, 0.62, 0.71, 0.74, 0.77, 1],
            ease: 'easeInOut',
          }}
          style={{ transformOrigin: '80px 62px' }}
        >
          <rect x="59" y="58" width="15" height="8" rx="4" fill="url(#tw-mascot-eye)" />
          <rect x="86" y="58" width="15" height="8" rx="4" fill="url(#tw-mascot-eye)" />
        </motion.g>

        {/* Terminal the mascot is working at */}
        <g>
          <rect
            x="58"
            y="98"
            width="44"
            height="24"
            rx="4"
            fill="var(--bg)"
            stroke="var(--teal)"
            strokeOpacity="0.4"
          />
          <motion.rect
            x="62"
            y="102"
            width="36"
            height="16"
            rx="2"
            fill="var(--teal)"
            animate={reduce ? undefined : { opacity: [0.22, 0.42, 0.22] }}
            transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
          />
          <path
            d="M54 122 L106 122 L116 132 L44 132 Z"
            fill="var(--card)"
            stroke="var(--teal)"
            strokeOpacity="0.4"
          />
        </g>

        {/* Hands — offset tap cycle so it reads as typing, not clapping */}
        <motion.circle
          cx="60"
          cy="116"
          r="6"
          fill="var(--card)"
          stroke="var(--teal)"
          strokeOpacity="0.4"
          animate={reduce ? undefined : { y: [0, -3, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.circle
          cx="100"
          cy="116"
          r="6"
          fill="var(--card)"
          stroke="var(--teal)"
          strokeOpacity="0.4"
          animate={reduce ? undefined : { y: [0, -3, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, ease: 'easeInOut', delay: 0.25 }}
        />
      </svg>
    </motion.div>
  );
}
