import type { DhanOptionChain, DhanOptionStrike } from '@/lib/dhanLiveFeed';

/**
 * Pure, framework-free helpers for the Sentinel Option Chain panel.
 *
 * Kept separate from the React hook/component so the strike selection and
 * formatting logic — the parts that have edge cases — are unit-testable
 * without a DOM or a network. The hook composes these over the live Dhan
 * chain fetch; the component only renders.
 */

/** One compact row for a CE or PE dropdown: just strike + last-traded price. */
export interface StrikeRow {
  strike: number;
  /** null when the leg has no quote (deep OTM strikes without a live tick). */
  ltp: number | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The nearest upcoming expiry from a list the bridge returns oldest-first.
 * Filters to well-formed ISO dates and, when today is known, drops past
 * dates so an already-expired contract is never selected. Returns null when
 * nothing valid remains.
 */
export function pickNearestExpiry(expiries: string[], todayIso?: string): string | null {
  const valid = expiries.filter((e) => ISO_DATE_RE.test(e)).sort();
  if (valid.length === 0) return null;
  if (!todayIso) return valid[0];
  const future = valid.filter((e) => e >= todayIso);
  return (future[0] ?? valid[valid.length - 1]) ?? null;
}

/**
 * How far past the midpoint between two strikes spot must travel before the
 * ATM is allowed to move, as a fraction of one strike step. Without this the
 * ATM flips on every poll while spot dithers around a boundary — and each flip
 * re-keys the CE/PE charts, firing two fresh Dhan historical calls, which is
 * what exhausted the rate limit mid-session.
 */
const ATM_HYSTERESIS_RATIO = 0.25;

/** Smallest gap between adjacent strikes in an ascending ladder, or null when
 *  there aren't two distinct strikes to measure. */
function strikeStep(strikes: { strike: number }[]): number | null {
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const gap = Math.abs(strikes[i].strike - strikes[i - 1].strike);
    if (gap > 0 && gap < step) step = gap;
  }
  return Number.isFinite(step) ? step : null;
}

/**
 * Index of the strike closest to spot; -1 for an empty ladder.
 *
 * `incumbentStrike` is the strike currently being shown, if any. Passing it
 * makes the choice sticky: the incumbent is kept until another strike is
 * nearer by more than ATM_HYSTERESIS_RATIO of a strike step, so a spot sitting
 * on a boundary doesn't oscillate. Omit it for a plain nearest-strike pick.
 */
export function nearestStrikeIndex(
  strikes: { strike: number }[],
  spot: number | null,
  incumbentStrike?: number | null,
): number {
  if (strikes.length === 0) return -1;
  if (spot == null) return Math.floor(strikes.length / 2);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const dist = Math.abs(strikes[i].strike - spot);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (incumbentStrike == null) return bestIdx;
  const incumbentIdx = strikes.findIndex((s) => s.strike === incumbentStrike);
  // The incumbent has left the ladder (window scrolled, expiry rolled) — no
  // one to be sticky about.
  if (incumbentIdx === -1) return bestIdx;
  const step = strikeStep(strikes);
  if (step == null) return bestIdx;
  const incumbentDist = Math.abs(strikes[incumbentIdx].strike - spot);
  return incumbentDist - bestDist > step * ATM_HYSTERESIS_RATIO ? bestIdx : incumbentIdx;
}

/** CE rows (strike + LTP) from a chain, ascending by strike. */
export function ceRows(chain: DhanOptionChain | null): StrikeRow[] {
  return legRows(chain, 'ce');
}

/** PE rows (strike + LTP) from a chain, ascending by strike. */
export function peRows(chain: DhanOptionChain | null): StrikeRow[] {
  return legRows(chain, 'pe');
}

function legRows(chain: DhanOptionChain | null, leg: 'ce' | 'pe'): StrikeRow[] {
  if (!chain || !Array.isArray(chain.strikes)) return [];
  return chain.strikes
    .map((s: DhanOptionStrike) => ({ strike: s.strike, ltp: s[leg]?.ltp ?? null }))
    .sort((a, b) => a.strike - b.strike);
}

/** Format an LTP for the dropdown; em-dash when unknown so a row never lies with 0.00. */
export function formatLtp(ltp: number | null): string {
  if (ltp == null || !Number.isFinite(ltp)) return '—';
  return ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Label for one dropdown option: "24350 · 128.75". */
export function strikeOptionLabel(row: StrikeRow): string {
  return `${row.strike} · ${formatLtp(row.ltp)}`;
}
