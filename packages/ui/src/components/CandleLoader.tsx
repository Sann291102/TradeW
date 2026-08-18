import { type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type CandleLoaderSize = 'sm' | 'md' | 'lg';

export interface CandleLoaderProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'aria-label' | 'aria-hidden'> {
  size?: CandleLoaderSize;
  /** Covers the viewport in a dimmed overlay, icon centered — for waits nothing else on screen can proceed past. */
  fullscreen?: boolean;
  /** Accessible status name. Ignored when `decorative` is set. */
  label?: string;
  /**
   * Set when the loader sits beside text that already says what's loading
   * (a button reading "Signing in…", a "Refreshing…" label) — announcing the
   * icon too would double up the same status for screen-reader users.
   * Standalone loaders (fullscreen, a lone icon replacing content) should
   * leave this false so `label` is the only thing announced.
   */
  decorative?: boolean;
}

const SIZE_PX: Record<CandleLoaderSize, number> = { sm: 18, md: 32, lg: 56 };

const CANDLES = [
  { x: 4, delay: '0s', bullish: true },
  { x: 15, delay: '0.15s', bullish: false },
  { x: 26, delay: '0.3s', bullish: true },
];

/**
 * CandleLoader — the app's one loading indicator (DESIGN-SYSTEM candle motif:
 * three bars rippling like a live candle chart). `currentColor`-based, so it
 * always matches its surrounding text/button color across all three themes
 * with no hardcoded hex. Self-contained: the keyframes live in a `<style>`
 * scoped inside the SVG rather than a shared stylesheet, so the component has
 * zero setup cost anywhere it's dropped in (mirrors the reference asset).
 */
export function CandleLoader({
  size = 'md',
  fullscreen = false,
  label = 'Loading',
  decorative = false,
  className,
  ...props
}: CandleLoaderProps) {
  const px = SIZE_PX[size];
  const announce = !fullscreen && !decorative;

  const icon = (
    <span
      role={announce ? 'status' : undefined}
      aria-label={announce ? label : undefined}
      aria-hidden={!announce && !fullscreen ? true : undefined}
      className={cn('inline-flex leading-none', !fullscreen && className)}
      {...(fullscreen ? {} : props)}
    >
      <svg width={px} height={px} viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <style>{`
          @keyframes candle-loader-wave {
            0%, 100% { transform: translateY(4px) scaleY(0.72); }
            50% { transform: translateY(-4px) scaleY(1.12); }
          }
          .candle-loader-wave {
            transform-box: fill-box;
            transform-origin: center;
            animation: candle-loader-wave 1.1s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .candle-loader-wave { animation-duration: 3s; }
          }
        `}</style>
        {CANDLES.map((c) => (
          <g key={c.x} className="candle-loader-wave" style={{ animationDelay: c.delay }}>
            <rect
              x={c.x + 2.5}
              y={4}
              width={1.5}
              height={28}
              rx={0.75}
              fill="currentColor"
              opacity={c.bullish ? 0.55 : 0.3}
            />
            <rect
              x={c.x}
              y={11}
              width={6.5}
              height={14}
              rx={1.5}
              fill="currentColor"
              opacity={c.bullish ? 1 : 0.5}
            />
          </g>
        ))}
      </svg>
    </span>
  );

  if (!fullscreen) return icon;

  return (
    <div
      role="status"
      aria-label={label}
      className={cn('fixed inset-0 z-50 flex items-center justify-center bg-black/50', className)}
      {...props}
    >
      {icon}
    </div>
  );
}

export default CandleLoader;
