import { ExchangeSegment, isExchangeSegment } from '../../contracts/instrument-ref';

/**
 * Parser for Dhan's instrument master CSV.
 *
 * Source: https://images.dhan.co/api-data/api-scrip-master-detailed.csv
 * This is a plain static download — no auth, no rate limit — which is why the
 * instrument master is Phase 1 and unblocked by the commercial questions in
 * DHAN-MARKET-DATA-INTEGRATION.md §3.
 *
 * The CSV is parsed here rather than with a library because the shape is fixed
 * and the only non-trivial case is quoted fields containing commas (display
 * names do). That is ~20 lines and avoids adding a dependency to a shared
 * package consumed by three services.
 */

export interface ScripMasterRow {
  securityId: string;
  exchangeSegment: ExchangeSegment;
  exchange: string;
  segment: string;
  tradingSymbol: string;
  displayName: string;
  symbolName: string;
  isin?: string;
  instrument?: string;
  instrumentType?: string;
  series?: string;
  lotSize?: number;
  tickSize?: number;
  expiryDate?: Date;
  expiryFlag?: string;
  strikePrice?: number;
  optionType?: string;
  underlyingSymbol?: string;
  underlyingSecurityId?: string;
}

/**
 * Split one CSV line, honouring double-quoted fields.
 * Handles the `""` escape for a literal quote inside a quoted field.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
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
 * Dhan publishes a "detailed" and a "compact" master with different column
 * names for the same data. Accepting both header vocabularies means the
 * importer keeps working if the URL is switched, instead of silently importing
 * rows with every optional field empty.
 */
const COLUMN_ALIASES: Record<keyof ScripMasterRow | 'exchangeSegmentRaw', string[]> = {
  securityId: ['SECURITY_ID', 'SEM_SMST_SECURITY_ID'],
  exchangeSegment: ['EXCH_SEGMENT', 'SEM_EXCH_SEGMENT'],
  exchangeSegmentRaw: ['SEGMENT', 'SEM_SEGMENT'],
  exchange: ['EXCH_ID', 'SEM_EXM_EXCH_ID'],
  segment: ['SEGMENT', 'SEM_SEGMENT'],
  tradingSymbol: ['TRADING_SYMBOL', 'SEM_TRADING_SYMBOL'],
  displayName: ['DISPLAY_NAME', 'SEM_CUSTOM_SYMBOL'],
  symbolName: ['SYMBOL_NAME', 'SM_SYMBOL_NAME'],
  isin: ['ISIN'],
  instrument: ['INSTRUMENT', 'SEM_INSTRUMENT_NAME'],
  instrumentType: ['INSTRUMENT_TYPE', 'SEM_EXCH_INSTRUMENT_TYPE'],
  series: ['SERIES', 'SEM_SERIES'],
  lotSize: ['LOT_SIZE', 'SEM_LOT_UNITS'],
  tickSize: ['TICK_SIZE', 'SEM_TICK_SIZE'],
  expiryDate: ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE'],
  expiryFlag: ['EXPIRY_FLAG', 'SEM_EXPIRY_FLAG'],
  strikePrice: ['STRIKE_PRICE', 'SEM_STRIKE_PRICE'],
  optionType: ['OPTION_TYPE', 'SEM_OPTION_TYPE'],
  underlyingSymbol: ['UNDERLYING_SYMBOL'],
  underlyingSecurityId: ['UNDERLYING_SECURITY_ID'],
};

/** Segments where the exchange `series` field is meaningful. */
const CASH_SEGMENTS: ReadonlySet<string> = new Set(['NSE_EQ', 'BSE_EQ']);

/** Exchange + segment letter -> Dhan exchangeSegment code. */
export function deriveExchangeSegment(exchange: string, segment: string): ExchangeSegment | null {
  const ex = exchange.trim().toUpperCase();
  const seg = segment.trim().toUpperCase();
  if (ex === 'NSE' && (seg === 'E' || seg === 'EQUITY')) return 'NSE_EQ';
  if (ex === 'NSE' && (seg === 'D' || seg === 'DERIVATIVE')) return 'NSE_FNO';
  // Currency derivatives (USDINR/EURINR/GBPINR/JPYINR). Dhan's master uses the
  // 'C' segment letter; spelled-out forms accepted for the same reason the
  // cases above accept them.
  if (ex === 'NSE' && (seg === 'C' || seg === 'CURRENCY')) return 'NSE_CURRENCY';
  if (ex === 'BSE' && (seg === 'C' || seg === 'CURRENCY')) return 'BSE_CURRENCY';
  if (ex === 'BSE' && (seg === 'E' || seg === 'EQUITY')) return 'BSE_EQ';
  if (ex === 'BSE' && (seg === 'D' || seg === 'DERIVATIVE')) return 'BSE_FNO';
  if (ex === 'MCX') return 'MCX_COMM';
  if (ex === 'IDX' || seg === 'I' || seg === 'INDEX') return 'IDX_I';
  return null;
}

export interface ParseResult {
  rows: ScripMasterRow[];
  /** Rows that looked wrong — malformed or unmappable. Surfaced so a bad import is never silent. */
  skipped: Array<{ line: number; reason: string }>;
  /**
   * Rows deliberately excluded by the segment/series filters. Counted
   * separately from `skipped` because they are the expected result of scoping,
   * not a data problem — conflating them buries real failures under ~120k
   * routine exclusions.
   */
  outOfScope: number;
  totalLines: number;
}

export interface ParseOptions {
  /** Only keep these segments. Omit to keep everything. */
  segments?: ExchangeSegment[];
  /**
   * Only keep these exchange series (NSE: EQ, BE, SM, ...). Rows with a blank
   * series — indices and derivatives — always pass, since the field only
   * applies to cash-segment instruments.
   *
   * This filter is load-bearing rather than cosmetic. NSE's equity segment
   * carries 9,620 rows of which only ~2,400 are shares; the rest are SDL
   * bonds, T-bills, mutual funds and government securities. Importing them all
   * produces 417 symbol collisions; restricting to EQ/BE produces 1.
   */
  series?: string[];
  /** Cap for tests and dry runs. */
  limit?: number;
}

export function parseScripMaster(csv: string, options: ParseOptions = {}): ParseResult {
  const lines = csv.split(/\r?\n/);
  const skipped: ParseResult['skipped'] = [];
  const rows: ScripMasterRow[] = [];

  let outOfScope = 0;
  const headerLine = lines.findIndex((l) => l.trim().length > 0);
  if (headerLine === -1) return { rows, skipped, outOfScope, totalLines: 0 };

  const headers = splitCsvLine(lines[headerLine]).map((h) => h.trim().toUpperCase());
  const index = (key: keyof typeof COLUMN_ALIASES): number => {
    for (const alias of COLUMN_ALIASES[key]) {
      const i = headers.indexOf(alias);
      if (i !== -1) return i;
    }
    return -1;
  };

  const col = {
    securityId: index('securityId'),
    exchangeSegment: index('exchangeSegment'),
    exchange: index('exchange'),
    segment: index('segment'),
    tradingSymbol: index('tradingSymbol'),
    displayName: index('displayName'),
    symbolName: index('symbolName'),
    isin: index('isin'),
    instrument: index('instrument'),
    instrumentType: index('instrumentType'),
    series: index('series'),
    lotSize: index('lotSize'),
    tickSize: index('tickSize'),
    expiryDate: index('expiryDate'),
    expiryFlag: index('expiryFlag'),
    strikePrice: index('strikePrice'),
    optionType: index('optionType'),
    underlyingSymbol: index('underlyingSymbol'),
    underlyingSecurityId: index('underlyingSecurityId'),
  };

  if (col.securityId === -1) {
    return {
      rows,
      skipped: [{ line: headerLine + 1, reason: `no security-id column found; headers were: ${headers.slice(0, 12).join(', ')}` }],
      outOfScope,
      totalLines: lines.length,
    };
  }

  const wanted = options.segments ? new Set<string>(options.segments) : null;
  const wantedSeries = options.series ? new Set(options.series.map((s) => s.toUpperCase())) : null;

  for (let i = headerLine + 1; i < lines.length; i++) {
    if (options.limit && rows.length >= options.limit) break;
    const raw = lines[i];
    if (!raw || raw.trim().length === 0) continue;

    const f = splitCsvLine(raw);
    const get = (idx: number): string => (idx >= 0 && idx < f.length ? f[idx].trim() : '');

    const securityId = get(col.securityId);
    if (!securityId) {
      skipped.push({ line: i + 1, reason: 'missing securityId' });
      continue;
    }

    const exchange = get(col.exchange);
    const segment = get(col.segment);
    const declared = get(col.exchangeSegment);
    const exchangeSegment = isExchangeSegment(declared) ? declared : deriveExchangeSegment(exchange, segment);

    if (!exchangeSegment) {
      // Currency (segment C) and NSE commodity (segment M) have no Dhan
      // exchangeSegment code and are not addressable by this integration —
      // an expected exclusion, not a parse failure.
      outOfScope++;
      continue;
    }
    if (wanted && !wanted.has(exchangeSegment)) {
      outOfScope++;
      continue;
    }

    // Series is a cash-equity concept only. Indices and derivatives carry a
    // placeholder that differs between the two published files ("NA" in the
    // detailed master, "X" in the compact one), so filtering them on it would
    // silently drop every index — and which placeholder appears depends on
    // which file is being read. Scoping the filter to cash segments is both
    // semantically correct and immune to that.
    const series = optionalField(get(col.series));
    if (wantedSeries && CASH_SEGMENTS.has(exchangeSegment) && series && !wantedSeries.has(series.toUpperCase())) {
      outOfScope++;
      continue;
    }

    const tradingSymbol = optionalField(get(col.tradingSymbol)) ?? optionalField(get(col.symbolName));
    if (!tradingSymbol) {
      skipped.push({ line: i + 1, reason: 'missing trading symbol' });
      continue;
    }

    rows.push({
      securityId,
      exchangeSegment,
      exchange: exchange || exchangeSegment.split('_')[0],
      segment,
      tradingSymbol,
      displayName: optionalField(get(col.displayName)) ?? tradingSymbol,
      symbolName: optionalField(get(col.symbolName)) ?? tradingSymbol,
      isin: optionalField(get(col.isin)),
      instrument: optionalField(get(col.instrument)),
      instrumentType: optionalField(get(col.instrumentType)),
      series,
      lotSize: toInt(get(col.lotSize)),
      tickSize: toFloat(get(col.tickSize)),
      expiryDate: toDate(get(col.expiryDate)),
      expiryFlag: optionalField(get(col.expiryFlag)),
      strikePrice: toFloat(get(col.strikePrice)),
      optionType: optionalField(get(col.optionType)),
      underlyingSymbol: optionalField(get(col.underlyingSymbol)),
      underlyingSecurityId: optionalField(get(col.underlyingSecurityId)),
    });
  }

  return { rows, skipped, outOfScope, totalLines: lines.length };
}

/**
 * Dhan writes the literal string "NA" for not-applicable rather than leaving
 * the field empty — index rows carry SERIES=NA, cash rows carry OPTION_TYPE=NA,
 * and so on. Treating that as a value rather than as absence silently excluded
 * every index from the import, so every optional string field goes through here.
 */
const NULL_PLACEHOLDERS = new Set(['', 'NA', 'N/A', '-', 'NULL']);

export function optionalField(v: string): string | undefined {
  const trimmed = v.trim();
  return NULL_PLACEHOLDERS.has(trimmed.toUpperCase()) ? undefined : trimmed;
}

/** Stable identity of a master row across the two published files. */
export function scripKey(row: Pick<ScripMasterRow, 'exchangeSegment' | 'securityId'>): string {
  return `${row.exchangeSegment}:${row.securityId}`;
}

/**
 * Merge the compact and detailed masters.
 *
 * Dhan publishes two files and neither is sufficient alone:
 *
 *   · compact  — has SEM_TRADING_SYMBOL, the actual exchange ticker
 *                ("RELIANCE"), but no ISIN and no underlying symbol.
 *   · detailed — has ISIN, underlying and richer classification, but NO ticker
 *                column at all. Its SYMBOL_NAME is the company name
 *                ("RELIANCE INDUSTRIES LTD"), which is unusable as a lookup key.
 *
 * The ticker is the platform's `Instrument.symbol` and what users search, so
 * compact is authoritative for identity and detailed supplies the extra fields.
 * Rows present only in detailed are dropped: without a ticker they cannot be
 * given a usable symbol.
 */
export function mergeScripMasters(compact: ScripMasterRow[], detailed: ScripMasterRow[]): ScripMasterRow[] {
  const detailByKey = new Map(detailed.map((row) => [scripKey(row), row]));
  return compact.map((row) => {
    const extra = detailByKey.get(scripKey(row));
    if (!extra) return row;
    return {
      ...row,
      isin: row.isin ?? extra.isin,
      underlyingSymbol: row.underlyingSymbol ?? extra.underlyingSymbol,
      underlyingSecurityId: row.underlyingSecurityId ?? extra.underlyingSecurityId,
      instrumentType: row.instrumentType ?? extra.instrumentType,
      // Prefer the detailed display name; it is the human-facing one.
      displayName: extra.displayName || row.displayName,
    };
  });
}

function toInt(v: string): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toFloat(v: string): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  // Dhan writes 0 for "not applicable" on strike/tick for non-derivatives.
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

function toDate(v: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
