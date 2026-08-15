import type { Candle } from '@tradew/types';
import { candleTime, type ZoneDrawing } from './drawings';

/**
 * Fair Value Gap detection — the first thing Tara draws on her own.
 *
 * ── WHAT A FAIR VALUE GAP IS, PRECISELY ────────────────────────────────────
 *
 * Three consecutive candles where the first and third do not overlap. The
 * middle candle moved far enough that a band of prices was skipped:
 *
 *   bullish — `a.high < c.low`, so the gap runs from `a.high` up to `c.low`
 *             and price is now ABOVE it
 *   bearish — `a.low  > c.high`, so the gap runs from `c.high` up to `a.low`
 *             and price is now BELOW it
 *
 * That is the whole definition. It is arithmetic on three bars, not a
 * judgement, which is exactly why it belongs in deterministic code rather than
 * in a model: there is one right answer and it is checkable.
 *
 * ── DETECTION IS COMPLETE; SUMMARISING IS SEPARATE ─────────────────────────
 *
 * `detectFVG` reports every gap it finds, with no size filter and no cap. A
 * detector that quietly drops "small" gaps is asserting a threshold nobody
 * chose, and the number it reports ("2 gaps") stops meaning what it says.
 * Trimming for what Tara *says out loud* is `nearestGaps`'s job, at the call
 * site, where the trimming is visible.
 *
 * ── NOT ADVICE ─────────────────────────────────────────────────────────────
 *
 * A gap is a description of where price moved quickly, nothing more. Nothing
 * here ranks, scores, or suggests a direction to trade (`TRADEW-AI.md` §4);
 * `direction` names which way the gap opened, not which way to lean.
 */

export type FvgDirection = 'bullish' | 'bearish';

export interface FairValueGap {
  direction: FvgDirection;
  /** Upper price bound of the skipped band. Always >= `bottom`. */
  top: number;
  /** Lower price bound of the skipped band. */
  bottom: number;
  /** Bar time (epoch seconds) of the FIRST candle of the three. */
  startTime: number;
  /** Bar time of the third candle — the point the gap is fully formed. */
  formedAt: number;
  /**
   * First bar after formation that traded back INTO the band, or null while
   * the gap is untouched. "Mitigated" in the usual sense.
   */
  mitigatedAt: number | null;
  /**
   * First bar that traded all the way THROUGH the band, or null. A gap can be
   * mitigated without being filled — price can poke in and leave — and
   * conflating the two overstates how much of the move has been retraced.
   */
  filledAt: number | null;
}

export interface DetectFvgOptions {
  /**
   * Ignore gaps thinner than this fraction of the third candle's close
   * (0.001 = 0.1%). Defaults to 0 — every gap is reported.
   *
   * Off by default deliberately: a default filter would make the count Tara
   * speaks depend on a threshold the user never saw.
   */
  minSizeFraction?: number;
}

/**
 * Has this band been traded back into by any bar after it formed?
 *
 * ── THE OFF-BY-ONE THAT MARKS EVERY GAP MITIGATED ──────────────────────────
 *
 * Scanning must start at the bar AFTER the third candle. The third candle is
 * what *creates* the boundary (`c.low` is the top of a bullish gap), so
 * including it means every gap is mitigated by its own definition the instant
 * it is found, and the chart draws nothing forever.
 *
 * Direction matters for which side counts as re-entry: a bullish gap sits
 * below price, so it is entered from above by a bar whose LOW drops into it;
 * a bearish gap sits above price and is entered by a bar whose HIGH rises
 * into it. Using one test for both silently halves the detection.
 */
export function isMitigated(
  gap: Pick<FairValueGap, 'direction' | 'top' | 'bottom' | 'formedAt'>,
  candles: readonly Candle[],
): { mitigatedAt: number | null; filledAt: number | null } {
  let mitigatedAt: number | null = null;
  let filledAt: number | null = null;

  for (const candle of candles) {
    const t = candleTime(candle);
    if (t <= gap.formedAt) continue;

    const touched = gap.direction === 'bullish' ? candle.low <= gap.top : candle.high >= gap.bottom;
    if (touched && mitigatedAt === null) mitigatedAt = t;

    const through = gap.direction === 'bullish' ? candle.low <= gap.bottom : candle.high >= gap.top;
    if (through && filledAt === null) filledAt = t;

    if (mitigatedAt !== null && filledAt !== null) break;
  }

  return { mitigatedAt, filledAt };
}

/**
 * Every fair value gap in `candles`, oldest first.
 *
 * Cost is O(n·m) where m is the number of gaps — each gap re-scans the bars
 * after it for mitigation. On the few hundred bars a chart shows this is
 * microseconds, which is why it runs on the main thread and not in a worker.
 * Revisit if this is ever pointed at a multi-year series.
 */
export function detectFVG(candles: readonly Candle[], options: DetectFvgOptions = {}): FairValueGap[] {
  const minSizeFraction = options.minSizeFraction ?? 0;
  const gaps: FairValueGap[] = [];
  if (candles.length < 3) return gaps;

  for (let i = 0; i + 2 < candles.length; i++) {
    const a = candles[i];
    const c = candles[i + 2];

    let direction: FvgDirection;
    let top: number;
    let bottom: number;

    if (a.high < c.low) {
      direction = 'bullish';
      bottom = a.high;
      top = c.low;
    } else if (a.low > c.high) {
      direction = 'bearish';
      bottom = c.high;
      top = a.low;
    } else {
      continue;
    }

    // Guard the divide: a zero/negative close would make the ratio meaningless
    // rather than merely small, so an unusable reference disables the filter
    // instead of silently discarding real gaps.
    if (minSizeFraction > 0 && c.close > 0 && (top - bottom) / c.close < minSizeFraction) continue;

    const formedAt = candleTime(c);
    const { mitigatedAt, filledAt } = isMitigated({ direction, top, bottom, formedAt }, candles);

    gaps.push({
      direction,
      top,
      bottom,
      startTime: candleTime(a),
      formedAt,
      mitigatedAt,
      filledAt,
    });
  }

  return gaps;
}

/** Gaps price has not yet returned to — the ones normally worth drawing. */
export function openGaps(gaps: readonly FairValueGap[]): FairValueGap[] {
  return gaps.filter((g) => g.mitigatedAt === null);
}

/**
 * The `n` gaps closest to `price`, nearest first.
 *
 * Distance is measured to the nearest EDGE of the band, and is zero when price
 * is inside it — measuring to the midpoint would rank a wide gap price is
 * already standing in behind a narrow one far above.
 */
export function nearestGaps(gaps: readonly FairValueGap[], price: number, n: number): FairValueGap[] {
  const distance = (g: FairValueGap) => (price > g.top ? price - g.top : price < g.bottom ? g.bottom - price : 0);
  return [...gaps].sort((x, y) => distance(x) - distance(y)).slice(0, Math.max(0, n));
}

/**
 * Render gaps as chart drawings.
 *
 * An unmitigated gap gets `endTime: null` so it keeps extending to the right
 * edge as new bars print — that is what "still open" looks like. A mitigated
 * one stops at the bar that entered it, because a zone that kept growing after
 * price came back would claim the gap is still there.
 *
 * The id is derived from the gap itself, so re-running detection on the same
 * bars produces the same ids and the chart's diff stays stable.
 */
export function toZoneDrawings(gaps: readonly FairValueGap[]): ZoneDrawing[] {
  return gaps.map((g) => ({
    kind: 'zone',
    id: `fvg:${g.direction}:${g.startTime}`,
    tag: 'fvg',
    direction: g.direction,
    top: g.top,
    bottom: g.bottom,
    startTime: g.startTime,
    endTime: g.mitigatedAt,
    label: g.mitigatedAt === null ? 'FVG' : 'FVG · mitigated',
  }));
}
