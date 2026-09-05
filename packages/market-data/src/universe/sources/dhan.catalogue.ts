/**
 * INDIA — the complete NSE + BSE catalogue, from Dhan's published scrip master.
 *
 * Reuses the CSV parser this package already owns (`dhan-scrip-master.ts`)
 * rather than re-parsing: that file already handles quoted fields, the two
 * different published header vocabularies, and Dhan's habit of writing the
 * literal string "NA" where a field is not applicable.
 *
 * WHAT CHANGES HERE versus the existing `ScripMasterService` import:
 *
 *   · SCOPE. That importer runs against `DEFAULT_SEGMENTS = [IDX_I, NSE_EQ]`
 *     and the EQ/BE series filter, because `Instrument.symbol` is globally
 *     unique and the full master collides on it immediately. The universe is
 *     keyed by (market, exchange, symbol), so BSE can be imported alongside NSE
 *     without RELIANCE colliding with itself, and the segment allowlist widens
 *     to every cash and index segment plus, optionally, derivatives.
 *
 *   · SERIES. Kept as a filter but for a different reason. NSE's equity segment
 *     is mostly not equities — of ~9,600 rows, roughly 4,300 are SDL state
 *     government bonds and the rest include T-bills, mutual funds and G-secs.
 *     Those are real instruments and the universe records them, but their
 *     series determines the asset class, so a bond is filed as BOND and not
 *     mislabelled EQUITY. Nothing is silently dropped any more; it is
 *     classified.
 *
 * The two masters are downloaded once and merged, exactly as the existing
 * importer does — compact carries the exchange ticker, detailed carries ISIN
 * and the underlying. Neither file alone is sufficient.
 */

import {
  mergeScripMasters,
  parseScripMaster,
  type ScripMasterRow,
} from '../../providers/dhan/dhan-scrip-master';
import type { ExchangeSegment } from '../../contracts/instrument-ref';
import { resolveCurrencyPolicy } from '../currency-policy';
import type {
  CatalogueFetchOptions,
  CataloguePage,
  CatalogueRecord,
  CatalogueSource,
  UniverseAssetClass,
  UniverseExchange,
} from '../universe.contracts';

export const SCRIP_MASTER_COMPACT_URL =
  process.env.DHAN_SCRIP_MASTER_COMPACT_URL || 'https://images.dhan.co/api-data/api-scrip-master.csv';
export const SCRIP_MASTER_DETAILED_URL =
  process.env.DHAN_SCRIP_MASTER_DETAILED_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

/**
 * Cash and index segments — the tradable universe for a paper-trading product.
 *
 * F&O is opt-in via `includeDerivatives` rather than on by default: the NSE
 * derivatives segment alone is ~120,000 contracts that expire weekly, so
 * including it multiplies the catalogue by an order of magnitude and makes most
 * of it stale within days. It is supported, not assumed.
 */
export const INDIA_CASH_SEGMENTS: ExchangeSegment[] = ['IDX_I', 'NSE_EQ', 'BSE_EQ'];
export const INDIA_DERIVATIVE_SEGMENTS: ExchangeSegment[] = ['NSE_FNO', 'BSE_FNO', 'NSE_CURRENCY', 'BSE_CURRENCY'];

const EXCHANGE_BY_SEGMENT: Readonly<Record<string, UniverseExchange>> = {
  NSE_EQ: 'NSE',
  NSE_FNO: 'NSE',
  NSE_CURRENCY: 'NSE',
  IDX_I: 'NSE',
  BSE_EQ: 'BSE',
  BSE_FNO: 'BSE',
  BSE_CURRENCY: 'BSE',
  MCX_COMM: 'NSE',
};

/**
 * NSE/BSE series -> asset class.
 *
 * The series letter is the exchange's own statement of what an instrument is,
 * and it is the only reliable signal in the cash segment: a G-sec and a share
 * are otherwise identical rows. Series not listed here fall through to EQUITY
 * only when the instrument column also says equity — see `classify`.
 */
const ASSET_CLASS_BY_SERIES: Readonly<Record<string, UniverseAssetClass>> = {
  // Equity
  EQ: 'EQUITY', // rolling settlement
  BE: 'EQUITY', // trade-to-trade
  BZ: 'EQUITY', // trade-to-trade, surveillance
  SM: 'EQUITY', // SME platform
  ST: 'EQUITY', // SME trade-to-trade
  MT: 'EQUITY',
  IQ: 'EQUITY',
  // Exchange-traded funds and index funds
  GB: 'ETF',
  GS: 'ETF',
  // Debt
  GC: 'BOND',
  SG: 'BOND', // sovereign gold bonds
  TB: 'BOND', // treasury bills
  SL: 'BOND', // state development loans
  GG: 'BOND',
  N1: 'BOND',
  N2: 'BOND',
  N3: 'BOND',
  N4: 'BOND',
  N5: 'BOND',
  N6: 'BOND',
  N7: 'BOND',
  N8: 'BOND',
  N9: 'BOND',
  NB: 'BOND',
  NC: 'BOND',
  ND: 'BOND',
  Y1: 'BOND',
  // Mutual fund units
  MF: 'FUND',
  // Warrants / rights
  W3: 'WARRANT',
  RE: 'WARRANT',
  RR: 'WARRANT',
  // REITs and InvITs
  RT: 'REIT',
  IV: 'REIT',
};

export interface DhanCatalogueOptions {
  compactUrl?: string;
  detailedUrl?: string;
  /** Supply CSV directly — tests and offline runs. */
  compactCsv?: string;
  detailedCsv?: string;
  /** Add the F&O and currency-derivative segments. Off by default; see above. */
  includeDerivatives?: boolean;
  segments?: ExchangeSegment[];
}

export class DhanCatalogueSource implements CatalogueSource {
  readonly id = 'dhan';
  readonly markets = ['INDIA'] as const;

  constructor(private readonly options: DhanCatalogueOptions = {}) {}

  /** Always available: the master is a static, unauthenticated download. */
  isConfigured(): boolean {
    return true;
  }

  async *pages(options: CatalogueFetchOptions = {}): AsyncGenerator<CataloguePage, void, undefined> {
    if (options.markets && !options.markets.includes('INDIA')) return;

    const segments =
      this.options.segments ??
      (this.options.includeDerivatives
        ? [...INDIA_CASH_SEGMENTS, ...INDIA_DERIVATIVE_SEGMENTS]
        : INDIA_CASH_SEGMENTS);

    const fetchImpl = options.fetchImpl ?? fetch;
    const [compactCsv, detailedCsv] = await Promise.all([
      this.options.compactCsv ??
        download(fetchImpl, this.options.compactUrl ?? SCRIP_MASTER_COMPACT_URL, options.signal),
      this.options.detailedCsv ??
        download(fetchImpl, this.options.detailedUrl ?? SCRIP_MASTER_DETAILED_URL, options.signal),
    ]);

    // `series` is deliberately NOT passed: the universe classifies by series
    // rather than filtering on it, so every listed instrument is discoverable
    // and a government bond is simply filed as a bond.
    const compact = parseScripMaster(compactCsv, { segments });
    const detailed = parseScripMaster(detailedCsv, { segments });
    const merged = mergeScripMasters(compact.rows, detailed.rows);

    const rejected: CataloguePage['rejected'] = [...compact.skipped, ...detailed.skipped].map((s) => ({
      reason: s.reason,
      sample: `line ${s.line}`,
    }));

    // One page per segment: the sync engine writes each as it completes, so a
    // 190k-row master is never held in memory as mapped records all at once,
    // and the run log reads segment by segment.
    const bySegment = new Map<string, ScripMasterRow[]>();
    for (const row of merged) {
      const bucket = bySegment.get(row.exchangeSegment);
      if (bucket) bucket.push(row);
      else bySegment.set(row.exchangeSegment, [row]);
    }

    let emitted = 0;
    for (const segment of segments) {
      const rows = bySegment.get(segment);
      if (!rows || rows.length === 0) continue;

      const records: CatalogueRecord[] = [];
      for (const row of rows) {
        if (options.limit && emitted >= options.limit) break;
        const record = toDhanRecord(row);
        if (!record) {
          rejected.push({ reason: 'unmappable segment', sample: row.tradingSymbol });
          continue;
        }
        records.push(record);
        emitted++;
      }

      yield { records, label: segment, rejected: rejected.splice(0, rejected.length) };
      if (options.limit && emitted >= options.limit) return;
    }
  }
}

async function download(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Dhan scrip master download failed: HTTP ${res.status} ${res.statusText} (${url})`);
  return res.text();
}

/** Map one Dhan master row onto the provider-neutral record. Exported for tests. */
export function toDhanRecord(row: ScripMasterRow): CatalogueRecord | null {
  const exchange = EXCHANGE_BY_SEGMENT[row.exchangeSegment];
  if (!exchange) return null;

  const symbol = row.tradingSymbol.trim().toUpperCase();
  if (!symbol) return null;

  const assetClass = classify(row);
  // Everything on NSE and BSE is quoted in rupees, and the master publishes no
  // per-instrument currency column, so the venue default is the only source.
  const currency = resolveCurrencyPolicy({ market: 'INDIA', exchange });

  return {
    market: 'INDIA',
    exchange,
    mic: exchange === 'NSE' ? 'XNSE' : 'XBOM',
    symbol,
    displayName: row.displayName?.trim() || row.symbolName?.trim() || symbol,
    assetClass,
    // The master lists what is currently tradable; it carries no status column.
    // A row's presence is the exchange saying it is listed, so ACTIVE is a
    // reported fact here, not an assumption. Absence on a later full run is what
    // marks a row DELISTED.
    status: 'ACTIVE',
    quoteCurrency: currency.quoteCurrency,
    country: 'IN',
    isin: row.isin,
    provider: 'dhan',
    // Dhan is addressed by (exchangeSegment, securityId) on every call and
    // never by ticker, so the securityId is the round-trip form.
    providerSymbol: row.securityId,
    securityId: row.securityId,
    exchangeSegment: row.exchangeSegment,
    series: row.series,
    lotSize: row.lotSize,
    tickSize: row.tickSize,
    raw: row,
  };
}

/**
 * What kind of instrument a master row is.
 *
 * Order matters: the index segment and the derivative instrument classes are
 * unambiguous and are decided first; only then does the cash-segment series
 * letter get consulted. A row whose series is unknown and whose instrument
 * column does not say EQUITY becomes OTHER rather than being guessed into
 * EQUITY — calling a bond a share is a worse answer than admitting uncertainty.
 */
export function classify(row: ScripMasterRow): UniverseAssetClass {
  const kind = (row.instrument ?? '').toUpperCase();
  const series = (row.series ?? '').toUpperCase();

  if (row.exchangeSegment === 'IDX_I' || kind === 'INDEX') return 'INDEX';
  if (kind.startsWith('OPT') || row.optionType) return 'OPTION';
  if (kind.startsWith('FUT')) return 'FUTURE';
  if (row.exchangeSegment === 'NSE_CURRENCY' || row.exchangeSegment === 'BSE_CURRENCY') return 'CURRENCY_PAIR';

  // The instrument column is consulted BEFORE the series letter for the two
  // classes where the series is genuinely ambiguous: most NSE ETFs trade under
  // series EQ, so a series-first lookup would file every one of them as an
  // ordinary share.
  if (kind === 'ETF') return 'ETF';
  if (kind === 'MF' || kind === 'MUTUAL_FUND') return 'FUND';

  const bySeries = ASSET_CLASS_BY_SERIES[series];
  if (bySeries) return bySeries;

  // Dhan's own instrument classification, where the series was no help.
  if (kind === 'EQUITY' || kind === 'ES') return 'EQUITY';
  if (kind.includes('BOND') || kind.includes('GSEC') || kind.includes('TBILL')) return 'BOND';

  return 'OTHER';
}
