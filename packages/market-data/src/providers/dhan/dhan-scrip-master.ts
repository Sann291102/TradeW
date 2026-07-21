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

/** Exchange + segment letter -> Dhan exchangeSegment code. */
export function deriveExchangeSegment(exchange: string, segment: string): ExchangeSegment | null {
  const ex = exchange.trim().toUpperCase();
  const seg = segment.trim().toUpperCase();
  if (ex === 'NSE' && (seg === 'E' || seg === 'EQUITY')) return 'NSE_EQ';
  if (ex === 'NSE' && (seg === 'D' || seg === 'DERIVATIVE')) return 'NSE_FNO';
  if (ex === 'BSE' && (seg === 'E' || seg === 'EQUITY')) return 'BSE_EQ';
  if (ex === 'BSE' && (seg === 'D' || seg === 'DERIVATIVE')) return 'BSE_FNO';
  if (ex === 'MCX') return 'MCX_COMM';
  if (ex === 'IDX' || seg === 'I' || seg === 'INDEX') return 'IDX_I';
  return null;
}

export interface ParseResult {
  rows: ScripMasterRow[];
  /** Rows skipped, with the reason — surfaced so a bad import is never silent. */
  skipped: Array<{ line: number; reason: string }>;
  totalLines: number;
}

export interface ParseOptions {
  /** Only keep these segments. Omit to keep everything. */
  segments?: ExchangeSegment[];
  /** Cap for tests and dry runs. */
  limit?: number;
}

export function parseScripMaster(csv: string, options: ParseOptions = {}): ParseResult {
  const lines = csv.split(/\r?\n/);
  const skipped: ParseResult['skipped'] = [];
  const rows: ScripMasterRow[] = [];

  const headerLine = lines.findIndex((l) => l.trim().length > 0);
  if (headerLine === -1) return { rows, skipped, totalLines: 0 };

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
      totalLines: lines.length,
    };
  }

  const wanted = options.segments ? new Set<string>(options.segments) : null;

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
      skipped.push({ line: i + 1, reason: `unmappable exchange/segment "${exchange}"/"${segment}"` });
      continue;
    }
    if (wanted && !wanted.has(exchangeSegment)) continue;

    const tradingSymbol = get(col.tradingSymbol) || get(col.symbolName);
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
      displayName: get(col.displayName) || tradingSymbol,
      symbolName: get(col.symbolName) || tradingSymbol,
      isin: get(col.isin) || undefined,
      instrument: get(col.instrument) || undefined,
      instrumentType: get(col.instrumentType) || undefined,
      series: get(col.series) || undefined,
      lotSize: toInt(get(col.lotSize)),
      tickSize: toFloat(get(col.tickSize)),
      expiryDate: toDate(get(col.expiryDate)),
      expiryFlag: get(col.expiryFlag) || undefined,
      strikePrice: toFloat(get(col.strikePrice)),
      optionType: get(col.optionType) || undefined,
      underlyingSymbol: get(col.underlyingSymbol) || undefined,
      underlyingSecurityId: get(col.underlyingSecurityId) || undefined,
    });
  }

  return { rows, skipped, totalLines: lines.length };
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
