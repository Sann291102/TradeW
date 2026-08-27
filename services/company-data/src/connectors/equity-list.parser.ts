/**
 * Parser for NSE's `EQUITY_L.csv` — the company universe.
 *
 * ── WHY THIS FILE IS THE FRONT DOOR ────────────────────────────────────────
 * One request returns every NSE-listed company with its ISIN (2,553 rows,
 * verified 2026-08-19). That single fact is what makes "every company, not just
 * popular companies" affordable: the alternative is a per-symbol call, which is
 * 2,553 requests to learn what one file already says.
 *
 * Because everything downstream is keyed on what this produces, the parser is
 * deliberately strict and deliberately LOSSY-BY-REPORT rather than
 * lossy-by-silence: a row it cannot read with confidence is returned in
 * `skipped` with a reason, never guessed at and never quietly dropped. A parser
 * that silently drops 40 rows produces a company list that is wrong in a way
 * nothing downstream can detect.
 *
 * Pure and dependency-free — no network, no database, no clock.
 */

export interface EquityListRow {
  symbol: string;
  name: string;
  /** EQ | BE | BZ — see `series` on SecurityListing for why it is kept. */
  series: string;
  listedOn: Date | null;
  paidUpValue: number | null;
  marketLot: number | null;
  isin: string;
  faceValue: number | null;
}

export interface SkippedRow {
  line: number;
  raw: string;
  reason: string;
}

export interface EquityListParseResult {
  rows: EquityListRow[];
  skipped: SkippedRow[];
  /** Header as found, trimmed — recorded so a silent upstream reshape is visible. */
  header: string[];
}

/**
 * The columns we require, in order, normalised.
 *
 * NSE's header is `SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP
 * VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE` — note the LEADING SPACE on every
 * column after the first. That is not a typo in this comment; it is what the
 * file contains, and matching header names without trimming is the documented
 * way to fail on this feed.
 */
const EXPECTED_HEADER = [
  'SYMBOL',
  'NAME OF COMPANY',
  'SERIES',
  'DATE OF LISTING',
  'PAID UP VALUE',
  'MARKET LOT',
  'ISIN NUMBER',
  'FACE VALUE',
];

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export class EquityListShapeError extends Error {}

export function parseEquityList(csv: string): EquityListParseResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new EquityListShapeError('EQUITY_L.csv was empty');

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toUpperCase());

  // Fail loudly on a reshaped file rather than parsing it by position and
  // producing plausible nonsense. If NSE reorders or renames a column, every
  // row would still "parse" — names would land in the series field and nothing
  // would throw. Positional parsing is only safe when the header is checked.
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((h, i) => header[i] === h)) {
    throw new EquityListShapeError(
      `EQUITY_L.csv header changed. Expected [${EXPECTED_HEADER.join(', ')}], got [${header.join(', ')}]`,
    );
  }

  const rows: EquityListRow[] = [];
  const skipped: SkippedRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const cells = splitCsvLine(raw).map((c) => c.trim());

    if (cells.length !== EXPECTED_HEADER.length) {
      skipped.push({ line: i + 1, raw, reason: `expected ${EXPECTED_HEADER.length} fields, found ${cells.length}` });
      continue;
    }

    const [symbol, name, series, listing, paidUp, lot, isin, faceValue] = cells;

    if (!symbol) {
      skipped.push({ line: i + 1, raw, reason: 'missing symbol' });
      continue;
    }
    if (!isValidIsin(isin)) {
      // ISIN is the join key to instruments and to every filing feed. A row
      // without a usable one cannot be linked to anything, so admitting it
      // would create an orphan company that silently never gains data.
      skipped.push({ line: i + 1, raw, reason: `invalid ISIN "${isin}"` });
      continue;
    }

    rows.push({
      symbol,
      name,
      series,
      listedOn: parseNseDate(listing),
      paidUpValue: parseNumber(paidUp),
      marketLot: parseNumber(lot),
      isin,
      faceValue: parseNumber(faceValue),
    });
  }

  return { rows, skipped, header };
}

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * Every row in the file today has exactly 8 unquoted fields, so a plain
 * `split(',')` would work — right up until a company name contains a comma
 * ("Bajaj Holdings, Ltd"), at which point every field after it shifts by one
 * and the ISIN check starts rejecting rows for no visible reason. Handling
 * quotes now costs a few lines; discovering this later costs an afternoon.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * `06-OCT-2008` → Date, or null.
 *
 * Built as a UTC date rather than a local one: a listing date is a calendar
 * day, not an instant, and constructing it locally would shift it across a day
 * boundary for anyone east of UTC — which includes every user of this product.
 */
export function parseNseDate(value: string): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (month === undefined) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month, day));
  // Rejects 31-FEB-2020, which would otherwise roll into March.
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date;
}

/** Null rather than 0 for anything unparseable — 0 is a claim, absence is not. */
export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return null;
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Indian ISINs: 'IN' + 10 alphanumerics. */
export function isValidIsin(value: string): boolean {
  return /^IN[A-Z0-9]{10}$/.test(value.trim().toUpperCase());
}

/**
 * What kind of security an ISIN denotes.
 *
 * The only classification available without a second source, and it exists for
 * one reason: to stop a fund being rendered with a P&L. EQUITY_L.csv contained
 * no INF rows on 2026-08-19, so this should never fire on that feed — but the
 * failure it guards against is silent, and an ETF with an invented balance
 * sheet is indistinguishable from a company with a real one.
 */
export function securityKindFromIsin(isin: string): 'EQUITY' | 'EQUITY_VARIANT' | 'FUND' | 'UNKNOWN' {
  const prefix = isin.trim().toUpperCase().slice(0, 3);
  if (prefix === 'INE') return 'EQUITY';
  if (prefix === 'IN9') return 'EQUITY_VARIANT';
  if (prefix === 'INF') return 'FUND';
  return 'UNKNOWN';
}

/**
 * The lookup form of an identifier.
 *
 * Upper-case and whitespace-collapsed. Applied identically when an alias is
 * WRITTEN and when one is SEARCHED — which is the whole point of storing it,
 * since a normalisation that differs between the two paths produces a unique
 * index that permits duplicates and a search that misses them.
 */
export function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Which share class a company page should default to.
 *
 * Ordinary equity (ISIN prefix INE) beats a variant (IN9 — DVR, partly paid),
 * because the ordinary share is what a price, a market cap and a peer
 * comparison normally mean. Ties break on the shorter symbol, which reliably
 * picks FEL over FELDVR and GATECH over GATECHDVR, then alphabetically so the
 * choice is deterministic rather than dependent on the order of the file.
 */
export function choosePrimaryListing(group: EquityListRow[]): EquityListRow {
  return [...group].sort((a, b) => {
    const rank = (r: EquityListRow) => (securityKindFromIsin(r.isin) === 'EQUITY' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.symbol.length !== b.symbol.length) return a.symbol.length - b.symbol.length;
    return a.symbol.localeCompare(b.symbol);
  })[0];
}
