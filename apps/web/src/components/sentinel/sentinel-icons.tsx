/**
 * Sentinel workspace iconography.
 *
 * Local to `/sentinel` rather than added to `components/shell/icons.tsx`:
 * these are the market-context glyphs the premium reference layout calls for
 * (volatility, momentum, structure, trap, liquidity, trend, institutional
 * participation) plus a handful of chrome icons, none of which the app shell
 * navigation needs. Same conventions as the shell set — 20x20 viewBox,
 * `currentColor` stroke, `aria-hidden`, size comes from the caller's class.
 */

export interface SentinelIconProps {
  className?: string;
}

const S = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Shield with a check — the Sentinel mark used beside the page title. */
export const ShieldCheckIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M10 2.5 4.5 4.8v4.4c0 3.3 2.2 6.3 5.5 7.4 3.3-1.1 5.5-4.1 5.5-7.4V4.8L10 2.5Z" />
    <path d="m7.6 9.8 1.7 1.7 3.3-3.4" />
  </svg>
);

/** Crown — entitlement marker on the Premium chip. */
export const CrownIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M3 6.5 5.6 12h8.8L17 6.5l-3.7 2.3L10 4 6.7 8.8 3 6.5Z" />
    <path d="M5.6 14.6h8.8" />
  </svg>
);

/** Clock — "last updated". */
export const ClockIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6.2V10l2.6 1.6" />
  </svg>
);

/** Hourglass — "waiting for stronger confirmation". */
export const HourglassIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M6 3h8M6 17h8" />
    <path d="M7 3v2.6c0 1.6 3 2.9 3 4.4 0 1.5-3 2.8-3 4.4V17" />
    <path d="M13 3v2.6c0 1.6-3 2.9-3 4.4 0 1.5 3 2.8 3 4.4V17" />
  </svg>
);

/** Expand arrows — the Live Charts full-screen toggle. */
export const FullScreenIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
  </svg>
);

/** Collapse arrows — shown while the charts panel is full-screen. */
export const ExitFullScreenIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />
  </svg>
);

/** Funnel — session timeline level filter. */
export const FilterIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M3.5 4.5h13l-5 5.6v5l-3 1.4v-6.4l-5-5.6Z" />
  </svg>
);

/** Tray with a down arrow — session timeline export. */
export const DownloadIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M10 3.5v8" />
    <path d="m6.8 8.6 3.2 3.2 3.2-3.2" />
    <path d="M4 13.5v1.6c0 .8.6 1.4 1.4 1.4h9.2c.8 0 1.4-.6 1.4-1.4v-1.6" />
  </svg>
);

/* --------------------------------------------------------------------------
 * Market-context dimension glyphs — one per `MarketContextDimension.label`
 * produced by `extractMarketContext` (lib/sentinel/deriveContext.ts).
 * ----------------------------------------------------------------------- */

/** Volatility — an oscillating pulse trace. */
export const VolatilityIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M2.5 10h2.8l1.8-5 2.6 10 2.2-7 1.5 2h4.1" />
  </svg>
);

/** Momentum — a bolt. */
export const MomentumIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M11 2.5 4.5 11h4l-.5 6.5L15 9h-4l0-6.5Z" />
  </svg>
);

/** Market structure — a rising step line with a marker. */
export const StructureIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M2.8 14.2 7 9.9l2.8 2.8 5.4-6" />
    <path d="M11.8 6.7h3.4v3.4" />
  </svg>
);

/** Trap probability — shield with an alert stroke. */
export const TrapIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M10 2.5 4.8 4.7v4.3c0 3.1 2.1 6 5.2 7 3.1-1 5.2-3.9 5.2-7V4.7L10 2.5Z" />
    <path d="M10 7.2v3M10 12.9v.1" />
  </svg>
);

/** Liquidity condition — a droplet. */
export const LiquidityIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M10 2.8c2.6 3 4.4 5.3 4.4 7.6a4.4 4.4 0 1 1-8.8 0c0-2.3 1.8-4.6 4.4-7.6Z" />
  </svg>
);

/** Trend state — a column chart. */
export const TrendIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M4.5 16v-4M8.2 16V6.5M11.8 16v-6.5M15.5 16V4" />
  </svg>
);

/** Institutional participation — a classical facade. */
export const InstitutionIcon = (p: SentinelIconProps) => (
  <svg {...S} className={p.className}>
    <path d="M2.8 7.6 10 3.4l7.2 4.2" />
    <path d="M5 8.8v5.6M9 8.8v5.6M13 8.8v5.6M16.5 8.8v5.6" />
    <path d="M3.4 16.6h13.2" />
  </svg>
);

/**
 * Dimension label → glyph. Keyed on the exact `label` strings
 * `extractMarketContext` emits; an unrecognised label falls back to the
 * structure glyph rather than rendering an empty slot, so adding a dimension
 * server-side degrades gracefully instead of breaking the tile grid.
 */
export const DIMENSION_ICONS: Record<string, (p: SentinelIconProps) => JSX.Element> = {
  Volatility: VolatilityIcon,
  Momentum: MomentumIcon,
  'Market structure': StructureIcon,
  'Trap probability': TrapIcon,
  'Liquidity condition': LiquidityIcon,
  'Trend state': TrendIcon,
  'Institutional participation': InstitutionIcon,
};

export function dimensionIcon(label: string) {
  return DIMENSION_ICONS[label] ?? StructureIcon;
}
