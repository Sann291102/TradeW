import { parseNseDate, parseNumber, splitCsvLine } from './equity-list.parser';

/**
 * Parser for NSE's `sec_bhavdata_full_DDMMYYYY.csv` — one session, whole market.
 *
 * ── WHY THIS IS THE PRICE-HISTORY SOURCE ───────────────────────────────────
 * A 52-week range for every listed company needs a year of daily bars for
 * ~2,500 securities. Through the broker's REST API that is ~2,500 rate-capped
 * requests and depends on a token that expires every 24 hours by SEBI rule and
 * cannot be renewed without a human completing a browser 2FA consent. Through
 * bhavcopy it is ~250 keyless requests — one per trading session, each covering
 * the entire market.
 *
 * ── THE TRAP THIS PARSER EXISTS TO CONTAIN ─────────────────────────────────
 * **The filename is not the session date.** Verified 2026-08-19:
 * `sec_bhavdata_full_16082026.csv` — a Sunday — returns HTTP 200 with 3,296
 * rows whose `DATE1` reads `14-Aug-2026`, the previous Friday. (Saturday 404s.
 * Sunday does not. There is no rule here to reason from, only behaviour to
 * observe.)
 *
 * Keying bars by the date we REQUESTED would therefore invent a Sunday session
 * holding a duplicate of Friday's bars. Nothing would error: the rows are
 * valid, the prices are real, and the unique index on (instrument, timeframe,
 * bucketStart) would happily accept them because the bucket differs. Every
 * 52-week high and low computed afterwards would be drawn from a series with
 * phantom sessions in it, and a "20-day average volume" would quietly be an
 * average over 20 rows that are not 20 days.
 *
 * So `parseBhavcopy` reads `DATE1` and returns it as `sessionDate`. Callers
 * must key on that, and must compare it against what they asked for.
 *
 * Pure and dependency-free.
 */

export interface BhavcopyRow {
  symbol: string;
  series: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  volume: number;
  /** Turnover in ₹ lakh, as published. */
  turnoverLakh: number | null;
  trades: number | null;
  deliveredQty: number | null;
  deliveredPct: number | null;
}

export interface BhavcopyParseResult {
  /**
   * The session these rows describe, read from DATE1 — NOT from the filename.
   * Null when the file carried no parseable date, which callers must treat as
   * unusable rather than defaulting to the requested day.
   */
  sessionDate: Date | null;
  rows: BhavcopyRow[];
  skipped: { line: number; reason: string }[];
}

export class BhavcopyShapeError extends Error {}

const EXPECTED_HEADER = [
  'SYMBOL',
  'SERIES',
  'DATE1',
  'PREV_CLOSE',
  'OPEN_PRICE',
  'HIGH_PRICE',
  'LOW_PRICE',
  'LAST_PRICE',
  'CLOSE_PRICE',
  'AVG_PRICE',
  'TTL_TRD_QNTY',
  'TURNOVER_LACS',
  'NO_OF_TRADES',
  'DELIV_QTY',
  'DELIV_PER',
];

/**
 * Series that represent ordinary listed equity.
 *
 * The file also carries GS (government securities), SM/ST (SME board), GB, IV,
 * N1, RR and others — 3,434 rows on 2026-08-18, of which only ~2,900 are
 * equity. Filtering here keeps government bonds out of a table whose consumers
 * assume they are looking at shares. EQ/BE/BZ are exactly the three series
 * `EQUITY_L.csv` publishes, so the two feeds agree by construction.
 */
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ']);

export function parseBhavcopy(csv: string): BhavcopyParseResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new BhavcopyShapeError('bhavcopy was empty');

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((h, i) => header[i] === h)) {
    // Same reasoning as the equity-list parser: a reordered file would still
    // "parse" positionally, and prices would land in the wrong columns.
    throw new BhavcopyShapeError(
      `bhavcopy header changed. Expected [${EXPECTED_HEADER.join(', ')}], got [${header.join(', ')}]`,
    );
  }

  const rows: BhavcopyRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const sessionDates = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]).map((c) => c.trim());
    if (cells.length !== EXPECTED_HEADER.length) {
      skipped.push({ line: i + 1, reason: `expected ${EXPECTED_HEADER.length} fields, found ${cells.length}` });
      continue;
    }

    const [symbol, series, date1, prevClose, open, high, low, , close, , qty, turnover, trades, deliv, delivPct] =
      cells;

    if (!EQUITY_SERIES.has(series)) continue; // not an error — just not equity

    const o = parseNumber(open);
    const h = parseNumber(high);
    const l = parseNumber(low);
    const c = parseNumber(close);

    if (o === null || h === null || l === null || c === null) {
      skipped.push({ line: i + 1, reason: `${symbol}: incomplete OHLC` });
      continue;
    }
    // A bar whose high is below its low, or which brackets neither open nor
    // close, is not a bar. Storing it would corrupt every range and every
    // indicator computed from the series, and nothing downstream re-checks.
    if (h < l || o > h || o < l || c > h || c < l) {
      skipped.push({ line: i + 1, reason: `${symbol}: inconsistent OHLC (o=${o} h=${h} l=${l} c=${c})` });
      continue;
    }

    if (date1) sessionDates.add(date1);

    rows.push({
      symbol,
      series,
      open: o,
      high: h,
      low: l,
      close: c,
      prevClose: parseNumber(prevClose),
      volume: parseNumber(qty) ?? 0,
      turnoverLakh: parseNumber(turnover),
      trades: parseNumber(trades),
      deliveredQty: parseNumber(deliv),
      deliveredPct: parseNumber(delivPct),
    });
  }

  // Every row in one file should carry the same DATE1. More than one means the
  // file is not what it claims to be, and guessing which date is "the" session
  // would be a coin flip that silently mis-stamps thousands of bars.
  if (sessionDates.size > 1) {
    throw new BhavcopyShapeError(
      `bhavcopy carries ${sessionDates.size} different DATE1 values: ${[...sessionDates].slice(0, 5).join(', ')}`,
    );
  }

  const sessionDate = sessionDates.size === 1 ? parseNseDate([...sessionDates][0]) : null;

  return { sessionDate, rows, skipped };
}

/** `YYYY-MM-DD` for a Date, in UTC — the form used for job scopes. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
