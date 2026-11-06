/** Number/price formatting helpers shared across the terminal UI. */

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const inrFmt0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Price/quantity with 2 decimals, Indian digit grouping. */
export function fmt(n: number): string {
  return inrFmt.format(n);
}

/**
 * The glyph shown where a number is genuinely unknown. An em-dash, so it reads
 * as "no value" at a glance and can never be mistaken for a quantity.
 */
export const NO_VALUE = '—';

/**
 * A price that may not be known.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `fmt(n)` above takes a `number`, so every call site that had a maybe-absent
 * price reached for `fmt(price ?? 0)` or `fmt(price || previousPrice)` — and
 * `fmt(0)` renders "0.00", a price. That is how a closed market came to be
 * reported on the dashboard as NIFTY 50 at 0.00: not one bug, but the same
 * defaulting reflex repeated at every card.
 *
 * The market-data feed now says `null` when it has never observed a price
 * (see DhanLiveQuote.ltp) and carries the last valid one forward otherwise, so
 * `null` here means the value is genuinely unknown and the only correct thing
 * to render is "—". Zero is never a fallback for a missing price.
 */
export function fmtPrice(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? fmt(n) : NO_VALUE;
}

/** Signed percent, or "—" when the move cannot be computed. An unmoved market
 *  ("+0.00%") and an unknown move are different facts. */
export function pctOrDash(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? pct(n) : NO_VALUE;
}

/** Signed absolute change, or "—". Pairs with `pctOrDash`. */
export function changeOrDash(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${sign(n)}${fmt(Math.abs(n))}` : NO_VALUE;
}

/** Rupee amount, no decimals (e.g. ₹4,86,500). */
export function inr(n: number, decimals: 0 | 2 = 0): string {
  return '₹' + (decimals === 0 ? inrFmt0 : inrFmt).format(Math.abs(n));
}

/** Leading sign for a signed number ("+" / "-"), empty for zero. */
export function sign(n: number): string {
  if (n > 0) return '+';
  if (n < 0) return '-';
  return '';
}

/** Signed percent string, e.g. "+0.54%". */
export function pct(n: number): string {
  return `${sign(n)}${Math.abs(n).toFixed(2)}%`;
}

/** Direction tone from a signed number, for market-direction coloring. */
export function tone(n: number): 'up' | 'down' | 'neutral' {
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'neutral';
}

/** Two-letter avatar initials from an email's local part, e.g. "vivek.s@x.com" → "VI". */
export function initials(email: string): string {
  const local = email.split('@')[0] || '';
  const letters = local.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 2) || '??').toUpperCase();
}
