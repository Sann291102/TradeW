import type { Candle } from '@tradew/types';
import type { ChartMarker, ChartPriceLine } from '@/components/charts/TradeChart';
import { candleTime } from './drawings';

/**
 * Strategy annotations → chart markers and levels.
 *
 * The client half of `services/api/src/paper-execution/chart-annotations.service.ts`.
 * Pure: it takes what the API returned plus the bars already on screen, and
 * returns what `TradeChart` draws. No fetching, so it is testable without a
 * network and cannot invent a decision that was not recorded.
 *
 * ## Why annotations are SNAPPED to bars
 *
 * lightweight-charts places a marker at a `time` that must correspond to a bar
 * in the series. An evaluation recorded at 10:07:23 does not; the 15-minute bar
 * it belongs to opens at 10:00. Passing the raw instant puts the marker at a
 * time the series has no data for, and the library silently drops it — the
 * failure looks exactly like "the bot did nothing", which is the one conclusion
 * this chart exists to make trustworthy.
 *
 * So every annotation is snapped to the last bar whose open is at or before it,
 * and an annotation with no such bar (older than the loaded history) is DROPPED
 * rather than clamped to the first bar. Clamping would stack every out-of-range
 * decision onto the left edge and read as a flurry of activity that never
 * happened.
 */

export interface StrategyAnnotation {
  kind: 'signal' | 'entry' | 'exit' | 'rejection';
  at: string;
  price: number | null;
  label: string;
  detail: string;
  strategyId: string | null;
  strategyName: string | null;
  confidence: number | null;
  regime: string | null;
  checkId?: string;
  until?: string;
  passes?: number;
  peakConfidence?: number | null;
  intentId?: string;
}

export interface StrategyLevel {
  kind: 'entry' | 'stop' | 'target' | 'trail';
  price: number;
  label: string;
  from: string;
  until: string | null;
  intentId: string;
}

export interface StrategyAnnotationSet {
  symbol: string;
  market: string | null;
  priceSpace: 'analysed' | 'traded';
  annotations: StrategyAnnotation[];
  levels: StrategyLevel[];
  levelsWithheld: boolean;
  withheldReason: string | null;
}

/**
 * How many passes a refusal span must cover before it earns a pin.
 *
 * A single 30-second pass that refused once and then moved on is noise; a span
 * that held for ten minutes is a state the agent was actually in. Without a
 * floor, a choppy morning produces a pin every few bars and the chart becomes
 * unreadable — which defeats the purpose as surely as drawing nothing.
 *
 * Signals, entries and exits are NEVER filtered by this. They are individually
 * meaningful and there are few of them.
 */
const MIN_REJECTION_PASSES = 4;

/**
 * Snap an instant to the last bar at or before it.
 *
 * Returns null when the instant predates every loaded bar — see the header for
 * why that must drop the annotation rather than clamp it.
 */
function snapToBar(atIso: string, barTimes: number[]): number | null {
  const t = Math.floor(new Date(atIso).getTime() / 1000);
  if (barTimes.length === 0 || t < barTimes[0]) return null;

  // Binary search for the rightmost bar with open <= t. Linear would be fine at
  // today's sizes, but a 24/7 crypto agent on 1m bars loads ~1,440 bars a day
  // against hundreds of annotations, and this runs on every render.
  let lo = 0;
  let hi = barTimes.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (barTimes[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return barTimes[lo];
}

/** Presentation for each annotation kind. Meaning here, colour from tokens. */
const MARKER_STYLE: Record<
  StrategyAnnotation['kind'],
  { position: ChartMarker['position']; shape: ChartMarker['shape']; colorToken: string }
> = {
  // Entry and exit are the two facts a trader looks for first, so they get the
  // arrows and sit clear of the bar.
  entry: { position: 'belowBar', shape: 'arrowUp', colorToken: '--green' },
  exit: { position: 'aboveBar', shape: 'arrowDown', colorToken: '--red' },
  // A signal is a decision, not a fill — a distinct shape so the two are never
  // confused. A REJECTED intent is still a signal: the agent reached a plan and
  // a bound stopped it, which is a more interesting refusal than "no setup".
  signal: { position: 'aboveBar', shape: 'circle', colorToken: '--accent' },
  // Refusals are deliberately the quietest thing on the chart. They are the
  // most numerous by far, and they are context rather than events.
  rejection: { position: 'belowBar', shape: 'square', colorToken: '--muted' },
};

export function annotationMarkers(
  annotations: readonly StrategyAnnotation[],
  candles: readonly Candle[] | null,
): ChartMarker[] {
  if (!candles?.length) return [];
  const barTimes = candles.map((c) => candleTime(c));

  const markers: ChartMarker[] = [];
  // One pin per (bar, kind). Several refusal spans can snap to the same bar on
  // a coarse timeframe, and stacked identical squares render as one smudged
  // block that cannot be read or hovered.
  const seen = new Set<string>();

  for (const a of annotations) {
    if (a.kind === 'rejection' && (a.passes ?? 1) < MIN_REJECTION_PASSES) continue;

    const time = snapToBar(a.at, barTimes);
    if (time === null) continue;

    const key = `${time}:${a.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const style = MARKER_STYLE[a.kind];
    markers.push({
      time,
      position: style.position,
      shape: style.shape,
      colorToken: style.colorToken,
      text: markerText(a),
    });
  }

  // lightweight-charts requires markers in ascending time order; out-of-order
  // entries are dropped without an error.
  return markers.sort((a, b) => a.time - b.time);
}

/**
 * The short on-chart label.
 *
 * Refusals carry their peak confidence because that is the number that decides
 * what to do next: "blocked at 58/70" and "blocked at 12/70" are the same
 * refusal and completely different situations.
 */
function markerText(a: StrategyAnnotation): string {
  if (a.kind === 'rejection') {
    const peak = a.peakConfidence;
    return peak != null ? `${a.label} · ${peak.toFixed(0)}%` : a.label;
  }
  if (a.kind === 'signal' && a.confidence != null) return `${a.label} ${a.confidence}%`;
  return a.label;
}

/**
 * Protection levels as horizontal price lines.
 *
 * Only levels still in force are drawn. A closed position's stop is history and
 * drawing it would suggest a live level on a chart a trader may act from — the
 * same class of error as the two-feed problem that keeps the TradingView embed
 * off rupee venues.
 */
export function annotationPriceLines(levels: readonly StrategyLevel[]): ChartPriceLine[] {
  return levels
    .filter((l) => l.until === null)
    .map((l) => ({
      price: l.price,
      title: l.label,
      colorToken:
        l.kind === 'stop'
          ? '--red'
          : l.kind === 'target'
            ? '--green'
            : l.kind === 'trail'
              ? '--amber'
              : '--accent',
      // Stop and target are hard levels; entry and trail are references. Dashed
      // vs solid is the only distinction available on a price line, so it is
      // spent on the one that matters most when glancing.
      dashed: l.kind === 'entry' || l.kind === 'trail',
    }));
}

/**
 * The annotation nearest a bar, for a tooltip.
 *
 * Returns every annotation snapped to that bar rather than just one — a bar can
 * carry both a signal and its entry, and showing one while hiding the other is
 * how a chart starts lying by omission.
 */
export function annotationsAtBar(
  annotations: readonly StrategyAnnotation[],
  candles: readonly Candle[] | null,
  barTime: number,
): StrategyAnnotation[] {
  if (!candles?.length) return [];
  const barTimes = candles.map((c) => candleTime(c));
  return annotations.filter((a) => snapToBar(a.at, barTimes) === barTime);
}
