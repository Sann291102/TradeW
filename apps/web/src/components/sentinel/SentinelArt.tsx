/**
 * Decorative artwork for the Sentinel workspace.
 *
 * Purely ornamental — every element is `aria-hidden` and nothing here encodes
 * a value, a price, or a state. The candles are fixed geometry, deliberately
 * NOT derived from market data: a decorative series that looked like a chart
 * but wasn't would be a lie about the tape, which is exactly what the rest of
 * this workspace refuses to do (a panel with no reachable data says so).
 *
 * Colors come from the design tokens (`var(--teal)` etc., tokens.css) so the
 * art re-themes with the app instead of carrying baked hex values.
 */

/** Fixed candle geometry: [x, wickTop, wickBottom, bodyTop, bodyHeight, up]. */
const HERO_CANDLES: [number, number, number, number, number, boolean][] = [
  [6, 58, 96, 66, 22, false],
  [20, 40, 88, 50, 30, true],
  [34, 30, 78, 38, 26, true],
  [48, 44, 104, 56, 36, false],
  [62, 22, 74, 30, 30, true],
  [76, 34, 92, 46, 32, false],
  [90, 14, 70, 22, 34, true],
  [104, 30, 86, 40, 28, true],
  [118, 48, 100, 58, 30, false],
  [132, 26, 80, 34, 32, true],
];

/**
 * The shield-and-tape emblem in the "Today's Market" hero card: a pulse-marked
 * shield over a soft radial glow, with a muted candle field behind it.
 */
export function ShieldHeroArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 300 190" className={className} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="sentinel-hero-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.30" />
          <stop offset="55%" stopColor="var(--teal)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sentinel-hero-shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0.06" />
        </linearGradient>
      </defs>

      {/* candle field — background texture only */}
      <g opacity="0.34">
        {HERO_CANDLES.map(([x, wickTop, wickBottom, bodyTop, bodyH, up], i) => (
          <g key={i} stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.4">
            <line x1={x + 4} y1={wickTop} x2={x + 4} y2={wickBottom} />
            <rect
              x={x}
              y={bodyTop}
              width="8"
              height={bodyH}
              rx="1.5"
              fill={up ? 'var(--green)' : 'var(--red)'}
              fillOpacity="0.28"
            />
          </g>
        ))}
      </g>

      {/* glow + concentric rings */}
      <circle cx="196" cy="95" r="86" fill="url(#sentinel-hero-glow)" />
      <circle cx="196" cy="95" r="70" fill="none" stroke="var(--teal)" strokeOpacity="0.16" />
      <circle cx="196" cy="95" r="54" fill="none" stroke="var(--teal)" strokeOpacity="0.22" />
      <path
        d="M136 128a70 70 0 0 1 0-66M256 62a70 70 0 0 1 0 66"
        fill="none"
        stroke="var(--teal)"
        strokeOpacity="0.5"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* shield */}
      <path
        d="M196 44l34 14v29c0 21-14 40-34 47-20-7-34-26-34-47V58l34-14Z"
        fill="url(#sentinel-hero-shield)"
        stroke="var(--teal)"
        strokeWidth="2"
      />
      {/* pulse trace inside the shield */}
      <path
        d="M175 96h9l5-13 7 26 5-15 4 6h10"
        fill="none"
        stroke="var(--teal)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Fixed candle geometry for the training card: [x, top, height, up]. */
const TRAINING_CANDLES: [number, number, number, boolean][] = [
  [12, 62, 26, true],
  [26, 48, 34, true],
  [40, 70, 22, false],
  [54, 36, 40, true],
  [68, 56, 30, false],
  [82, 28, 46, true],
  [96, 50, 28, true],
  [110, 66, 24, false],
  [124, 34, 42, true],
  [138, 52, 30, true],
];

/**
 * The radar-sweep emblem in the Training card — arcs plus the same decorative
 * candle field, sized for a short, wide slot.
 */
export function TrainingRadarArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 120" className={className} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="sentinel-training-glow" cx="50%" cy="60%" r="55%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="100" cy="70" r="72" fill="url(#sentinel-training-glow)" />

      <g fill="none" stroke="var(--teal)" strokeOpacity="0.22">
        <path d="M22 96a78 78 0 0 1 156 0" />
        <path d="M44 96a56 56 0 0 1 112 0" />
        <path d="M66 96a34 34 0 0 1 68 0" />
      </g>

      <g opacity="0.6">
        {TRAINING_CANDLES.map(([x, top, h, up], i) => (
          <g key={i} stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.3">
            <line x1={x + 4} y1={top - 8} x2={x + 4} y2={top + h + 8} />
            <rect
              x={x}
              y={top}
              width="8"
              height={h}
              rx="1.5"
              fill={up ? 'var(--green)' : 'var(--red)'}
              fillOpacity="0.3"
            />
          </g>
        ))}
      </g>
    </svg>
  );
}
