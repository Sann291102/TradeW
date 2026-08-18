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

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFAULT STRIKE WINDOW, AND WHY IT IS SIX ROWS
//
// The brief asks the CE and PE dropdowns to open on six strikes — "3 from ITM
// and 3 OTM" — and pins it with an example: at spot 24500 the selectable
// strikes are 24350, 24400, 24450, 24500, 24550, 24600. The SAME six were
// specified for both sides.
//
// That list is three steps BELOW the at-the-money row, the at-the-money row
// itself, and two ABOVE it. Note what it is not: a per-side moneyness split.
// Classifying per side (ITM = below spot for a CALL, above spot for a PUT)
// reproduces the example for CE and contradicts it for PE — it would put the
// put ladder on 24400…24650. The specified list is one shared window centred
// on the ATM, so that is what this builds, and both sides get it.
//
// The window is a DEFAULT VIEW, never a restriction on what exists: the
// combobox searches the whole real ladder, because "only currently available
// strikes" and "searchable" are both requirements and a six-row cap would make
// the search pointless. Every row in either list is a strike Dhan actually
// published for that expiry — see `legRows`.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows offered before the operator types anything. */
export const STRIKE_WINDOW_SIZE = 6;
/** How many of those sit below the at-the-money row. */
export const STRIKE_WINDOW_BELOW = 3;

/**
 * The six-strike default window around the at-the-money row.
 *
 * Slides rather than truncates at the ends of the ladder: near the top or
 * bottom of a published chain the window shifts to keep six rows, so the
 * operator never sees a three-item dropdown because spot drifted to the edge.
 * A ladder shorter than six rows is returned whole — padding it would mean
 * inventing strikes, which is the one thing this must never do.
 *
 * `atmIndex` is the index `useOptionChainStrikes` resolved from the REAL
 * ladder (with hysteresis). An out-of-range index falls back to the middle of
 * the ladder rather than throwing: an unusable window is a worse answer than a
 * slightly off-centre one, and the rows are real either way.
 */
export function strikeWindow(rows: StrikeRow[], atmIndex: number): StrikeRow[] {
  if (rows.length === 0) return [];
  if (rows.length <= STRIKE_WINDOW_SIZE) return [...rows];
  const centre = atmIndex >= 0 && atmIndex < rows.length ? atmIndex : Math.floor(rows.length / 2);
  const start = Math.min(Math.max(centre - STRIKE_WINDOW_BELOW, 0), rows.length - STRIKE_WINDOW_SIZE);
  return rows.slice(start, start + STRIKE_WINDOW_SIZE);
}

/**
 * Rows whose strike contains the typed digits, for the searchable input.
 *
 * Substring, not prefix: a trader hunting the 24450 leg types "445" as often
 * as "244". Non-digit characters are ignored so "24,450" and "24450 CE" both
 * find the row. An empty query returns nothing here — the CALLER decides that
 * an empty query means `strikeWindow`, which keeps "what is the default view"
 * in one place instead of two.
 */
export function filterStrikes(rows: StrikeRow[], query: string): StrikeRow[] {
  const digits = query.replace(/\D/g, '');
  if (!digits) return [];
  return rows.filter((r) => String(r.strike).includes(digits));
}

/**
 * Why a typed strike could not be used. Each case gets its own message in the
 * UI, because "24337 is not a listed strike" and "the chain has not loaded"
 * are different problems with different fixes.
 */
export type StrikeRejection = 'empty' | 'not-a-number' | 'no-ladder' | 'not-listed';

export type StrikeResolution = { ok: true; row: StrikeRow } | { ok: false; reason: StrikeRejection };

/**
 * Resolve free text to a strike that genuinely trades on THIS side's ladder.
 *
 * ⚠️ **Never snaps to the nearest listed strike.** Typing 24337 into the CE box
 * is rejected; it does not become 24350. A silent substitution would create a
 * watch on a contract the operator did not choose and could not see they had
 * not chosen — the brief calls this out explicitly, and it is the same class of
 * fault as the ATM fallback that made the old charts look connected.
 *
 * `rows` must be the ladder for ONE side. Passing the CE ladder is what makes
 * a CE box unable to return a PE contract; the type system cannot enforce that,
 * so the call sites are the guard and are tested as such.
 */
export function resolveTypedStrike(rows: StrikeRow[], query: string): StrikeResolution {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const value = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(value)) return { ok: false, reason: 'not-a-number' };
  if (rows.length === 0) return { ok: false, reason: 'no-ladder' };
  const row = rows.find((r) => r.strike === value);
  return row ? { ok: true, row } : { ok: false, reason: 'not-listed' };
}

/** Is this strike a row on the given side's live ladder? */
export function isListedStrike(rows: StrikeRow[], strike: number | null): boolean {
  return strike !== null && rows.some((r) => r.strike === strike);
}
