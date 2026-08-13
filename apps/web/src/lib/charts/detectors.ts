import type { Candle } from '@tradew/types';
import type { ChartDrawing, DrawingTag } from './drawings';
import { detectFVG, nearestGaps, openGaps, toZoneDrawings, type FairValueGap } from './fvg';

/**
 * The registry of things Tara can find on a chart by herself.
 *
 * One entry per detector, and the entry owns all three of: what it draws, what
 * tag it draws under, and how it is described out loud. Splitting those apart
 * is how a detector ends up drawing under one tag and clearing another — the
 * bug that leaves stale zones on the chart forever with no way to remove them.
 *
 * ── EVERY SPOKEN NUMBER COMES FROM THE SAME OBJECT THAT WAS DRAWN ──────────
 *
 * `summarize` is handed the detector's own output, not a re-derivation. This
 * is the AI-OS rule ("structured JSON is authoritative for anything numeric")
 * applied at the smallest scale: what Tara says and what the chart shows are
 * the same data, so they cannot disagree. A second pass over the candles to
 * produce the sentence would be a second source of truth.
 */

export type DetectorId = 'fvg';

export interface DetectorRun {
  drawings: ChartDrawing[];
  /** One sentence, plain enough to be read aloud by `useVoiceOutput`. */
  summary: string;
  /** Trace lines for the dock — what was scanned and what came back. */
  steps: string[];
}

export interface DetectorSpec {
  id: DetectorId;
  tag: DrawingTag;
  /** How the detector is named in a plan preview: "Mark fair value gaps". */
  label: string;
  run(candles: readonly Candle[], lastPrice: number | null): DetectorRun;
}

/** How many gaps get named individually before the rest are counted. */
const SPOKEN_GAP_LIMIT = 2;

function describeGap(g: FairValueGap): string {
  return `${g.direction} ${round(g.bottom)}–${round(g.top)}`;
}

function round(n: number): string {
  // Two decimals only where they carry information — index levels read as
  // "24450", option premiums as "142.35".
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export const DETECTORS: Record<DetectorId, DetectorSpec> = {
  fvg: {
    id: 'fvg',
    tag: 'fvg',
    label: 'Mark fair value gaps',
    run(candles, lastPrice) {
      const all = detectFVG(candles);
      const open = openGaps(all);
      const drawings = toZoneDrawings(all);

      const steps = [
        `Scanned ${candles.length} bar${candles.length === 1 ? '' : 's'}`,
        `Found ${all.length} fair value gap${all.length === 1 ? '' : 's'} · ${open.length} still open`,
      ];

      if (all.length === 0) {
        return {
          drawings,
          summary: 'No fair value gaps on the bars currently loaded.',
          steps,
        };
      }

      // Nearest-first, and only when there is a price to measure against —
      // without one, ordering by "nearest" would be a claim we cannot support.
      const spoken = lastPrice === null ? open.slice(0, SPOKEN_GAP_LIMIT) : nearestGaps(open, lastPrice, SPOKEN_GAP_LIMIT);
      const mitigated = all.length - open.length;

      const parts: string[] = [
        `${open.length} open fair value gap${open.length === 1 ? '' : 's'}`,
      ];
      if (spoken.length) parts.push(spoken.map(describeGap).join(', '));
      if (mitigated > 0) parts.push(`${mitigated} already mitigated`);

      return {
        drawings,
        summary: `${parts.join(' — ')}.`,
        steps,
      };
    },
  },
};

/** Resolve a spoken detector name, or null. Used by the command grammar. */
export function detectorFor(id: string): DetectorSpec | null {
  return (DETECTORS as Record<string, DetectorSpec | undefined>)[id] ?? null;
}
