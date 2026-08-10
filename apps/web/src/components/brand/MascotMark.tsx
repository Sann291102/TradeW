/**
 * MascotMark — the TradeW AI robot reduced to an icon.
 *
 * The full mascot (`components/landing/Mascot.tsx`) is a 160×160 illustration:
 * chassis, terminal, hands, a rotating candlestick brain. None of that survives
 * being drawn at 22px, which is the size the floating assistant trigger needs.
 * So this is the same character cropped to what still reads at icon scale —
 * antenna, rounded head, side pods, two eyes — keeping the silhouette
 * recognisable as the SAME robot rather than introducing a second identity.
 *
 * Deliberately monochrome `currentColor`, unlike the full mascot's token
 * palette. The mascot is drawn in `--card`/`--bg` with a teal rim because it
 * sits on the page background; this mark sits INSIDE a filled teal button,
 * where a card-coloured chassis would disappear. Inheriting the parent's text
 * colour means one component works on the teal FAB, on a card, and in a header
 * without a per-surface variant.
 *
 * Pure SVG, no motion and no 'use client' — it renders inside server components
 * (marketing sections) and client ones (the FAB) alike.
 */
export function MascotMark({
  size = 24,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Supply only when the mark is the sole label for a control. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
    >
      {title && <title>{title}</title>}

      {/* Antenna — the single most recognisable "this is a robot" cue at 22px */}
      <path d="M12 2.9v1.9" />
      <circle cx="12" cy="1.9" r="1.05" fill="currentColor" stroke="none" />

      {/* Head */}
      <rect x="3.9" y="5" width="16.2" height="12.6" rx="4.4" />

      {/* Side pods */}
      <path d="M3.9 10.1H2.6v2.6h1.3M20.1 10.1h1.3v2.6h-1.3" />

      {/* Eyes — filled, so they stay solid rather than turning into rings when
          the stroke width is scaled down at small sizes. */}
      <rect x="7.7" y="9.5" width="2.9" height="3.6" rx="1.45" fill="currentColor" stroke="none" />
      <rect x="13.4" y="9.5" width="2.9" height="3.6" rx="1.45" fill="currentColor" stroke="none" />

      {/* Readout slot on the chin — stands in for the mascot's terminal */}
      <path d="M9.4 15h5.2" />
    </svg>
  );
}
