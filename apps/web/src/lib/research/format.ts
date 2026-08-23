/**
 * Research formatting.
 *
 * ── THE ONE INVARIANT ──────────────────────────────────────────────────────
 *
 * Nothing here accepts `undefined` and returns a number-shaped string. Every
 * formatter takes a definite value; deciding whether there IS a value is the
 * caller's job, and the caller renders `<NotReported/>` when there is not. That
 * split is deliberate: a `formatMoney(value ?? 0)` helper is exactly how "not
 * reported" becomes "₹0.00", and this surface exists because that class of bug
 * shipped once already.
 */

/** Indian grouping for INR, Western for everything else — a market cap in
 *  rupees is read in crore, and 19,31,000 is the readable form of that. */
function groupingLocale(currency: string): string {
  return currency === 'INR' ? 'en-IN' : 'en-US';
}

/**
 * Compact magnitude with the scale word the market actually uses.
 *
 * INR uses crore/lakh because an Indian financial statement is read that way;
 * every other currency uses the short scale.
 */
export function compactMoney(value: number, currency: string): string {
  const locale = groupingLocale(currency);
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (currency === 'INR') {
    if (abs >= 1e7) return `${sign}${(abs / 1e7).toLocaleString(locale, { maximumFractionDigits: 2 })} Cr`;
    if (abs >= 1e5) return `${sign}${(abs / 1e5).toLocaleString(locale, { maximumFractionDigits: 2 })} L`;
    return `${sign}${abs.toLocaleString(locale, { maximumFractionDigits: 2 })}`;
  }
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/** Full precision, grouped. Used in statement cells, where a reader is
 *  cross-checking against a filing and needs every digit. */
export function statementValue(value: number, currency: string): string {
  const locale = groupingLocale(currency);
  // Per-share figures and ratios need decimals; statement magnitudes do not.
  const decimals = Math.abs(value) < 1000 ? 2 : 0;
  return value.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Accounting negatives.
 *
 * Parenthesised, because that is how a statement reads and because a minus sign
 * at small type is easy to miss on a line that changes the meaning of the page.
 */
export function accountingValue(value: number, currency: string): string {
  const formatted = statementValue(Math.abs(value), currency);
  return value < 0 ? `(${formatted})` : formatted;
}

/**
 * Statement display scale.
 *
 * A large Indian issuer files revenue around ₹9,74,00,00,00,000. At full
 * precision that is fifteen digits in a table cell, and a reader comparing five
 * of them across a row cannot tell 97 thousand crore from 9.7 thousand crore by
 * looking. Filings are read in crore for exactly this reason, so the table
 * offers the scale rather than forcing one.
 *
 * `full` is kept and is the honest default for currencies whose magnitudes are
 * legible unscaled — scaling is a presentation choice, and a reader
 * cross-checking a filing line by line wants the digits.
 */
export type DisplayScale = 'full' | 'thousand' | 'lakh' | 'crore' | 'million' | 'billion';

export interface ScaleOption {
  key: DisplayScale;
  label: string;
  /** Divisor applied to every value in the table. */
  divisor: number;
  /** Rendered in the table's unit caption, e.g. "INR crore". */
  suffix: string;
}

/** Scales offered for a currency. Indian statements are read in lakh/crore;
 *  everything else in thousands/millions/billions. */
export function scalesFor(currency: string): ScaleOption[] {
  if (currency === 'INR') {
    return [
      { key: 'crore', label: 'Crore', divisor: 1e7, suffix: 'crore' },
      { key: 'lakh', label: 'Lakh', divisor: 1e5, suffix: 'lakh' },
      { key: 'full', label: 'Full', divisor: 1, suffix: '' },
    ];
  }
  return [
    { key: 'million', label: 'Millions', divisor: 1e6, suffix: 'millions' },
    { key: 'billion', label: 'Billions', divisor: 1e9, suffix: 'billions' },
    { key: 'thousand', label: 'Thousands', divisor: 1e3, suffix: 'thousands' },
    { key: 'full', label: 'Full', divisor: 1, suffix: '' },
  ];
}

/**
 * Pick the default scale from the DATA, not from the currency alone.
 *
 * Defaulting INR to crore unconditionally is right for a large issuer and wrong
 * for a small one: a company with ₹1,000 of revenue would render "0.00" — a real
 * value displayed as nothing, which is the same class of misleading output this
 * page exists to eliminate, arriving through formatting instead of through data.
 *
 * So the largest absolute magnitude in the statement chooses the unit: the
 * coarsest scale at which that value still shows at least one whole unit. A
 * magnitude of 0 (an all-absent statement) falls through to `full`.
 */
export function defaultScale(currency: string, magnitude = 0): ScaleOption {
  const options = scalesFor(currency);
  for (const opt of options) {
    if (opt.divisor === 1) continue;
    if (Math.abs(magnitude) / opt.divisor >= 1) return opt;
  }
  return options.find((o) => o.divisor === 1) ?? options[0]!;
}

/**
 * A scaled accounting value.
 *
 * Per-share figures (EPS) and share counts must NOT be scaled — dividing an EPS
 * of ₹18.28 by a crore produces 0.0000018, which is not a number anyone reads.
 * The caller passes `scaled: false` for those rows, and the table's unit caption
 * says so.
 */
export function scaledAccountingValue(value: number, currency: string, scale: ScaleOption, scaled: boolean): string {
  if (!scaled || scale.divisor === 1) return accountingValue(value, currency);
  const v = value / scale.divisor;
  const locale = groupingLocale(currency);
  // Two decimals once scaled: at crore, a whole-number rounding hides a
  // difference of up to ten million rupees between two periods.
  const formatted = Math.abs(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${formatted})` : formatted;
}

export function percent(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}%`;
}

export function multiple(value: number): string {
  return `${value.toFixed(2)}×`;
}

export function ratio(value: number): string {
  return value.toFixed(2);
}

export function formatRatio(value: number, unit: 'x' | 'percent' | 'ratio' | 'currency', currency?: string): string {
  if (unit === 'percent') return percent(value);
  if (unit === 'x') return multiple(value);
  if (unit === 'currency' && currency) return compactMoney(value, currency);
  return ratio(value);
}

/** `FY2026` / `FY2026 Q3` — the column heading. */
export function periodLabel(period: { fiscalYear: number; fiscalQuarter?: number }): string {
  return period.fiscalQuarter !== undefined ? `FY${period.fiscalYear} Q${period.fiscalQuarter}` : `FY${period.fiscalYear}`;
}

/** An absolute, unambiguous timestamp. Research is cross-checked against
 *  filings, so "2 hours ago" is the wrong unit — a reader needs the date. */
export function asOf(iso: string | null): string {
  if (!iso) return 'no timestamp published by the source';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'timestamp unreadable';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

export function asOfDate(iso: string | null): string {
  if (!iso) return 'date not published';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date unreadable';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
}
