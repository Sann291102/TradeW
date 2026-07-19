/** Number/price formatting helpers shared across the terminal UI. */

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const inrFmt0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Price/quantity with 2 decimals, Indian digit grouping. */
export function fmt(n: number): string {
  return inrFmt.format(n);
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
