/**
 * The chart drawing model — Tara's hands on the chart (AI-OPERATING-SYSTEM.md §5).
 *
 * Week 1 of the Tara build order. Everything downstream ("FVG", "draw
 * trendline", order blocks, liquidity zones) renders through the two
 * primitives declared here, so this file is deliberately the whole vocabulary:
 * a drawing that cannot be expressed as a zone or a line does not exist yet.
 *
 * ── WHY THIS IS FRAMEWORK-FREE ─────────────────────────────────────────────
 *
 * No lightweight-charts import, no React. The geometry is the part that is
 * easy to get wrong and impossible to eyeball (a zone drawn one bar to the
 * left is still a plausible-looking rectangle), so it is resolved by pure
 * functions that take injected coordinate converters and are asserted in
 * `drawings.test.ts`. `components/charts/drawingPrimitive.ts` supplies the
 * real converters from the chart and does nothing but paint.
 *
 * ── TIME IS EPOCH SECONDS, LIKE EVERY OTHER CANDLE IN THE REPO ─────────────
 *
 * `Candle.time` is epoch **seconds, UTC** (see the Dhan REST/WS split in
 * `Gotchas/2026-08-11 - Dhan WebSocket LTT is an IST-based epoch`). Drawings
 * are derived from candles, so they carry the same convention and the cast to
 * lightweight-charts' `UTCTimestamp` happens once, at the paint boundary.
 */

/**
 * The one conversion from a `Candle` to a chart time.
 *
 * Shared with `TradeChart` rather than duplicated, because a drawing time that
 * disagrees with the series' bar time by even one second is not a *visible*
 * failure: `timeToCoordinate` simply returns null for a time that is not a bar,
 * and `resolveZoneRect` then clamps the zone to the left edge. The result is a
 * confident rectangle in the wrong place. One function, used by both, makes
 * that class of drift impossible.
 */
export function candleTime(candle: { timestamp: Date }): number {
  return Math.floor(candle.timestamp.getTime() / 1000);
}

/**
 * Which producer put this drawing on the chart.
 *
 * Load-bearing rather than cosmetic: it is the unit of erasure. Re-running FVG
 * detection must replace *only* the FVG zones and leave a trendline the user
 * drew by hand untouched — so every write is scoped by tag, and there is no
 * "clear the chart" that a detector can reach.
 */
export type DrawingTag = 'fvg' | 'swing' | 'trendline' | 'order-block' | 'liquidity' | 'user';

/** Bullish/bearish drive the color; `neutral` renders in the muted token. */
export type DrawingDirection = 'bullish' | 'bearish' | 'neutral';

interface DrawingBase {
  /** Stable within a tag — a redraw of the same feature reuses its id. */
  id: string;
  tag: DrawingTag;
  direction: DrawingDirection;
  /** Rendered at the drawing's left edge when there is room for it. */
  label?: string;
}

/**
 * A price band across a time range — fair value gaps, order blocks, supply and
 * demand zones. One shape covers all of them; only the tag and color differ.
 */
export interface ZoneDrawing extends DrawingBase {
  kind: 'zone';
  /** Upper price bound. `normalizeZone` guarantees top >= bottom. */
  top: number;
  bottom: number;
  /** Epoch seconds. Must be an actual bar time on the series being drawn. */
  startTime: number;
  /**
   * `null` means **open to the right edge** — the zone has not been resolved
   * and should keep extending as new bars print. This is the normal state of
   * an unmitigated fair value gap, and modelling it as null rather than as
   * "some time far in the future" is what keeps the renderer from having to
   * guess whether a far-future timestamp was intentional.
   */
  endTime: number | null;
}

/** A two-point segment — trendlines, and the swing structure they connect. */
export interface LineDrawing extends DrawingBase {
  kind: 'line';
  from: { time: number; price: number };
  to: { time: number; price: number };
  /** Continue past `to` to the right edge, the way a drawn trendline does. */
  extendRight?: boolean;
  dashed?: boolean;
}

export type ChartDrawing = ZoneDrawing | LineDrawing;

// ---------------------------------------------------------------------------
// Tag-scoped collection edits
// ---------------------------------------------------------------------------

/** Everything except the given tag. Backs `CHART_CLEAR_DRAWINGS`. */
export function clearDrawingsByTag(drawings: readonly ChartDrawing[], tag: DrawingTag): ChartDrawing[] {
  return drawings.filter((d) => d.tag !== tag);
}

export function drawingsWithTag(drawings: readonly ChartDrawing[], tag: DrawingTag): ChartDrawing[] {
  return drawings.filter((d) => d.tag === tag);
}

/**
 * Replace every drawing carrying `tag` with `next`, preserving all other tags
 * and their relative order.
 *
 * This is the only write a detector performs. It is a wholesale replace rather
 * than a merge because a detector's output is a complete statement about the
 * visible range — an FVG that was mitigated since the last run must *vanish*,
 * and a merge would leave it on the chart forever.
 */
export function replaceDrawingsByTag(
  drawings: readonly ChartDrawing[],
  tag: DrawingTag,
  next: readonly ChartDrawing[],
): ChartDrawing[] {
  if (next.some((d) => d.tag !== tag)) {
    throw new Error(`replaceDrawingsByTag: every replacement must carry tag "${tag}"`);
  }
  return [...clearDrawingsByTag(drawings, tag), ...next];
}

/** Guarantee `top >= bottom` so the renderer never produces a negative height. */
export function normalizeZone(zone: ZoneDrawing): ZoneDrawing {
  if (zone.top >= zone.bottom) return zone;
  return { ...zone, top: zone.bottom, bottom: zone.top };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The chart's coordinate converters, injected so the geometry can be tested
 * without a canvas.
 *
 * Both converters return `null` for values the chart cannot place — a price
 * outside the visible scale, or a time that is not a bar in the loaded series.
 * That null is information, not an error, and each call site below decides
 * what it means rather than treating them all the same.
 */
export interface DrawingViewport {
  /** Media-space x for a bar time, or null if the time is not in the series. */
  timeToX(time: number): number | null;
  /** Media-space y for a price, or null if it is off the price scale. */
  priceToY(price: number): number | null;
  /** Pane width in media pixels — the right edge an open zone extends to. */
  paneWidth: number;
}

export interface ResolvedRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Place a zone in pane coordinates, or null if it should not be painted.
 *
 * Three rules, each of which was a bug waiting to happen:
 *
 *  1. **A missing price is fatal, a missing time is not.** If either edge of
 *     the band cannot be placed the zone's height is unknown and drawing it
 *     would state a price level that is not the one detected. But a start time
 *     that has scrolled off the left of the loaded series is perfectly
 *     ordinary — the zone is simply clipped to the left edge.
 *  2. **An open zone runs to the right edge**, and so does one whose
 *     `endTime` is not a bar in the current series (a 15m zone shown on a 1D
 *     chart). Falling back to the edge keeps it visible and correct-looking;
 *     falling back to `x1` would collapse it to an invisible sliver and read
 *     as "detection found nothing".
 *  3. **Fully off-screen returns null** rather than being painted outside the
 *     clip, so the renderer's work stays proportional to what is visible.
 */
export function resolveZoneRect(zone: ZoneDrawing, view: DrawingViewport): ResolvedRect | null {
  const z = normalizeZone(zone);

  const y1 = view.priceToY(z.top);
  const y2 = view.priceToY(z.bottom);
  if (y1 === null || y2 === null) return null;

  const x1 = view.timeToX(z.startTime) ?? 0;
  const x2 = z.endTime === null ? view.paneWidth : view.timeToX(z.endTime) ?? view.paneWidth;

  if (x2 < x1) return null;
  if (x2 < 0 || x1 > view.paneWidth) return null;

  return { x1, y1, x2, y2 };
}

export interface ResolvedSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Place a line segment in pane coordinates, or null if it cannot be drawn.
 *
 * Stricter than a zone on purpose: a trendline's meaning is entirely in its
 * slope, so clamping an unplaceable endpoint to the pane edge would silently
 * change the angle of the line. Either both endpoints resolve or nothing is
 * drawn. `extendRight` is applied afterwards, along the slope the two real
 * points define — never as a guess.
 */
export function resolveLineSegment(line: LineDrawing, view: DrawingViewport): ResolvedSegment | null {
  const x1 = view.timeToX(line.from.time);
  const y1 = view.priceToY(line.from.price);
  const x2 = view.timeToX(line.to.time);
  const y2 = view.priceToY(line.to.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

  if (!line.extendRight || x2 <= x1) return { x1, y1, x2, y2 };

  // Extend along the real slope to the pane's right edge.
  const slope = (y2 - y1) / (x2 - x1);
  const xEnd = view.paneWidth;
  if (xEnd <= x2) return { x1, y1, x2, y2 };
  return { x1, y1, x2: xEnd, y2: y2 + slope * (xEnd - x2) };
}
