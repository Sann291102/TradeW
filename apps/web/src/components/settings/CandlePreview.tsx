'use client';

/**
 * A live preview of the candle colours, drawn as SVG.
 *
 * Deliberately NOT a `TradeChart`. The preview has to render the colours as
 * the user is dragging a picker, before anything is saved and before the CSS
 * custom properties on `<html>` have changed — so it takes the colours as
 * props and paints them directly. Mounting a real chart here would also mean
 * a lightweight-charts instance on a settings page for four bars.
 *
 * The bar geometry is fixed and meaningless — it exists to show a body, a wick
 * and both directions, nothing more. It is not market data and is not
 * presented as any.
 */
const BARS = [
  { x: 12, open: 58, close: 30, high: 20, low: 66, up: true },
  { x: 42, open: 30, close: 44, high: 24, low: 52, up: false },
  { x: 72, open: 44, close: 22, high: 16, low: 50, up: true },
  { x: 102, open: 22, close: 40, high: 18, low: 48, up: false },
];

export function CandlePreview({ up, down, hollowUp }: { up: string; down: string; hollowUp: boolean }) {
  return (
    <svg
      viewBox="0 0 128 80"
      role="img"
      aria-label="Preview of your chosen bullish and bearish candle colours"
      className="h-20 w-full max-w-[240px]"
    >
      {BARS.map((bar) => {
        const color = bar.up ? up : down;
        const top = Math.min(bar.open, bar.close);
        const height = Math.max(2, Math.abs(bar.close - bar.open));
        const hollow = bar.up && hollowUp;
        return (
          <g key={bar.x}>
            <line x1={bar.x + 7} x2={bar.x + 7} y1={bar.high} y2={bar.low} stroke={color} strokeWidth={1.6} />
            <rect
              x={bar.x}
              y={top}
              width={14}
              height={height}
              fill={hollow ? 'transparent' : color}
              stroke={color}
              strokeWidth={hollow ? 1.6 : 0}
            />
          </g>
        );
      })}
    </svg>
  );
}
