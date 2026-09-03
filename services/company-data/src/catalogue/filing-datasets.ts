/**
 * The company-data sources this service may read — a closed, named catalogue.
 *
 * ── WHY A CATALOGUE AND NOT A FETCHER ──────────────────────────────────────
 * Identical reasoning to `services/api/src/nse/nse-datasets.ts`, and deliberately
 * the same shape so there is one pattern in this repo rather than two. Restated
 * because this catalogue is larger and the temptation is correspondingly bigger:
 *
 *  1. **A URL parameter on a server-side fetcher is an SSRF primitive.** This
 *     service sits inside the network with the database. Anything that turns a
 *     caller-supplied string into an outbound request from that position is a
 *     hole, and "but it validates the hostname" is one redirect away from not
 *     being true.
 *
 *  2. **Fetched content is data, never instruction.** These endpoints carry
 *     company-authored prose — `attchmntText` on an announcement, `bm_desc` on
 *     a board meeting, `remarksWeb` on a shareholding filing. If a caller could
 *     name a URL, that prose could be steered into a model context. A named
 *     dataset returning parsed, typed values cannot carry an instruction.
 *
 * Adding a dataset is a code change with a review. That is the control.
 *
 * ── SCOPE: WHAT A DATASET IS ADDRESSED BY ──────────────────────────────────
 * `'market'` datasets take no argument and describe the whole exchange (the
 * equity list). `'symbol'` datasets take exactly one NSE symbol. `'date'`
 * datasets take one calendar day (`YYYY-MM-DD`) and describe one session.
 * Nothing takes a free-form string: every scope value is validated against a
 * pattern BEFORE it is encoded, so it can never introduce a path segment or a
 * query parameter of its own.
 *
 * ── VERIFIED, NOT ASSUMED ──────────────────────────────────────────────────
 * Every entry below was probed live on 2026-08-19 and returned real data for
 * RELIANCE. Findings, gotchas and the two endpoints that DON'T work are recorded
 * in `knowledge/API/2026-08-19 - NSE corporate filings and XBRL fundamentals`.
 * Notably `/api/quote-equity` answers 403 to this client and is therefore
 * absent — market cap does not come from there.
 *
 * Pure and dependency-free so the boundary is unit-testable on its own.
 */

export type FilingDatasetId =
  | 'nse.equity-list'
  | 'nse.announcements'
  | 'nse.corporate-actions'
  | 'nse.board-meetings'
  | 'nse.financial-results'
  | 'nse.financial-results-annual'
  | 'nse.shareholding'
  | 'nse.annual-reports'
  | 'nse.bhavcopy';

export type DatasetScope = 'market' | 'symbol' | 'date';

/** What kind of thing comes back — decides which parser may touch it. */
export type DatasetFormat = 'json' | 'csv' | 'xbrl';

export interface FilingDataset {
  id: FilingDatasetId;
  /** What it answers, in one line. */
  describes: string;
  scope: DatasetScope;
  host: 'www.nseindia.com' | 'archives.nseindia.com' | 'nsearchives.nseindia.com';
  format: DatasetFormat;
  /** Path builder. Receives an ALREADY-VALIDATED, encoded scope value. */
  path: (scope: string) => string;
  /** The page a browser would be on when it makes this call — NSE checks Referer. */
  referer: string;
  /**
   * How often to re-read, in ms.
   *
   * Set by how often the SOURCE publishes, never by how often a caller asks.
   * Shareholding is a quarterly filing: polling it hourly would fetch the same
   * document ~2,000 times to learn nothing. The daily cadence here is a
   * compromise — it is how quickly we want to NOTICE the quarterly publication,
   * which is a different question from how often it changes.
   */
  cadenceMs: number;
  /**
   * True when the payload describes completed/filed history rather than a live
   * value. Consumers must render these with their own period, never as "now".
   */
  historical: boolean;
  /**
   * Carries company-authored free text. Such fields are stored but must never
   * reach a model context unsandboxed, and must never be treated as instruction.
   */
  carriesProse: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FILINGS_BASE = 'https://www.nseindia.com/companies-listing';

/**
 * NSE symbols as they actually appear in EQUITY_L.csv: upper-case alphanumerics
 * plus `&`, `-` and space (e.g. `M&M`, `BAJAJ-AUTO`). Anything else is refused
 * rather than encoded, because a symbol is the ONLY caller-influenced part of
 * any URL this service builds and a permissive pattern here is the whole attack
 * surface.
 */
export const SYMBOL_PATTERN = /^[A-Z0-9&\- ]{1,32}$/;

/** Date scopes, as ISO calendar days. Reformatted per-dataset by the builder. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const FILING_DATASETS: Record<FilingDatasetId, FilingDataset> = {
  /**
   * The company universe: 2,554 rows, one request, whole market.
   *
   * THE ENTRY THAT MAKES "EVERY COMPANY" AFFORDABLE. It carries ISIN, which is
   * the join key to `Instrument.isin` and therefore to the identity spine —
   * without it, resolving a filing to a company would be name matching, which
   * is a guess wearing a suit.
   */
  'nse.equity-list': {
    id: 'nse.equity-list',
    describes: 'Every NSE-listed equity: symbol, company name, series, listing date, ISIN, face value',
    scope: 'market',
    host: 'archives.nseindia.com',
    format: 'csv',
    path: () => 'https://archives.nseindia.com/content/equities/EQUITY_L.csv',
    referer: 'https://www.nseindia.com/',
    // The list changes on listings, delistings and symbol changes — daily is
    // ample, and it is one small file.
    cadenceMs: DAY,
    historical: false,
    carriesProse: false,
  },

  /**
   * Corporate announcements.
   *
   * MEASURED 2026-08-19: RELIANCE alone returns 3,341 items / 2.8 MB with no
   * pagination parameter in play. Fanning this across 2,554 companies every
   * fifteen minutes would be ~7 GB per poll, which is why the ingestion job
   * checkpoints on `seq_id` and why this must eventually carry a date window.
   * The cadence below is the NOTICE latency we want, not a licence to refetch
   * everything each time.
   */
  'nse.announcements': {
    id: 'nse.announcements',
    describes: 'Corporate announcements with attachment PDFs and an XBRL flag',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    path: (s) => `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${s}`,
    referer: `${FILINGS_BASE}/corporate-filings-announcements`,
    cadenceMs: 15 * MINUTE,
    historical: false,
    // `attchmntText` is company-authored prose.
    carriesProse: true,
  },

  /**
   * Dividends, splits, bonuses, rights.
   *
   * `subject` is free text ("Dividend - Rs 6 Per Share") — the ratio and amount
   * have to be parsed out of it, and a parse that fails must record the raw
   * string rather than invent a zero.
   */
  'nse.corporate-actions': {
    id: 'nse.corporate-actions',
    describes: 'Corporate actions: ex-date, record date, subject, face value, ISIN',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    path: (s) => `https://www.nseindia.com/api/corporates-corporateActions?index=equities&symbol=${s}`,
    referer: `${FILINGS_BASE}/corporate-filings-actions`,
    cadenceMs: DAY,
    historical: true,
    carriesProse: true,
  },

  'nse.board-meetings': {
    id: 'nse.board-meetings',
    describes: 'Board meetings: date, purpose, attachment',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    path: (s) => `https://www.nseindia.com/api/corporate-board-meetings?index=equities&symbol=${s}`,
    referer: `${FILINGS_BASE}/corporate-filings-board-meetings`,
    cadenceMs: DAY,
    historical: false,
    // `bm_desc` is company-authored. `services/api`'s NSE event-calendar reader
    // drops the equivalent field for exactly this reason.
    carriesProse: true,
  },

  /**
   * Financial results — the LISTING, whose rows each carry an `xbrl` URL.
   *
   * This dataset does not return statements. It returns the index of filings,
   * from which the XBRL documents are fetched individually (see
   * `nse.financial-results-xbrl` handling in the ingestion layer). Two steps on
   * purpose: the listing is small and pollable, the documents are large and
   * immutable once published.
   *
   * Consolidated and standalone arrive as SEPARATE filings, which is why the
   * canonical model never has to infer consolidation.
   */
  'nse.financial-results': {
    id: 'nse.financial-results',
    describes: 'Filed results index (quarterly and annual), each row carrying its XBRL document URL',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    // `period` is fixed to Quarterly here; the annual sweep is a separate job
    // scope rather than a caller-supplied parameter.
    path: (s) => `https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol=${s}&period=Quarterly`,
    referer: `${FILINGS_BASE}/corporate-filings-financial-results`,
    // Results cluster into a few weeks a year. The scheduler tightens this
    // during results season rather than the catalogue guessing a single number.
    cadenceMs: 6 * HOUR,
    historical: true,
    carriesProse: false,
  },

  /**
   * The same listing, annual periods.
   *
   * A SEPARATE ENTRY rather than a `period` argument on the entry above. The
   * catalogue's whole guarantee is that a caller names a dataset and never
   * composes a URL — the moment one query parameter becomes caller-supplied,
   * that guarantee is a convention rather than a control, and the next
   * parameter is easier to add than this comment is to write.
   */
  'nse.financial-results-annual': {
    id: 'nse.financial-results-annual',
    describes: 'Filed ANNUAL results index, each row carrying its XBRL document URL',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    path: (s) => `https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol=${s}&period=Annual`,
    referer: `${FILINGS_BASE}/corporate-filings-financial-results`,
    // Annual filings land once a year. Daily is about noticing, not change.
    cadenceMs: DAY,
    historical: true,
    carriesProse: false,
  },

  'nse.shareholding': {
    id: 'nse.shareholding',
    describes: 'Quarterly shareholding pattern filings, each carrying its XBRL document URL',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    path: (s) => `https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=${s}`,
    referer: `${FILINGS_BASE}/corporate-filings-shareholding-pattern`,
    // A quarterly publication. Daily is about noticing it, not about change.
    cadenceMs: DAY,
    historical: true,
    // `remarksWeb` is long company-authored prose.
    carriesProse: true,
  },

  'nse.annual-reports': {
    id: 'nse.annual-reports',
    describes: 'Annual report documents by financial year',
    scope: 'symbol',
    host: 'www.nseindia.com',
    format: 'json',
    path: (s) => `https://www.nseindia.com/api/annual-reports?index=equities&symbol=${s}`,
    referer: `${FILINGS_BASE}/corporate-filings-annual-reports`,
    cadenceMs: 7 * DAY,
    historical: true,
    carriesProse: false,
  },

  /**
   * One session's full equity bhavcopy: OHLC, volume, turnover and delivery
   * for every traded security.
   *
   * THE SOURCE THAT MAKES A 52-WEEK RANGE AFFORDABLE. One file per trading day
   * covers the entire market (~3,400 rows, ~390 KB), so a year of history for
   * every listed company is ~250 requests rather than one request per company.
   * It is also keyless, so it does not depend on the broker token — which
   * expires every 24 hours by SEBI rule and cannot be renewed without a human
   * completing a browser 2FA consent.
   *
   * Plain CSV deliberately, not the UDiFF `BhavCopy_NSE_CM_*.csv.zip` on the
   * same host: that one is a ZIP, and adding an archive dependency to read a
   * file that is also published uncompressed is a cost with no return.
   *
   * ⚠ THE FILENAME IS NOT THE SESSION DATE. Verified 2026-08-19:
   * `sec_bhavdata_full_16082026.csv` — a SUNDAY — returns HTTP 200 with 3,296
   * rows whose DATE1 is 14-Aug-2026, the previous Friday. Saturday 404s;
   * Sunday does not. Keying bars by the requested date would therefore invent a
   * Sunday session holding a duplicate of Friday's bars, and every 52-week high
   * or low computed afterwards would be drawn from a series with phantom days
   * in it. The parser reads DATE1 and the caller must honour it.
   */
  'nse.bhavcopy': {
    id: 'nse.bhavcopy',
    describes: "One session's equity bhavcopy — OHLC, volume, turnover, delivery — for the whole market",
    scope: 'date',
    host: 'nsearchives.nseindia.com',
    format: 'csv',
    // Scope arrives validated as YYYY-MM-DD; NSE wants DDMMYYYY.
    path: (s) => `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${s}.csv`,
    referer: 'https://www.nseindia.com/all-reports',
    // Once per session. The scheduler drives history by enqueueing dates, not
    // by polling this faster.
    cadenceMs: DAY,
    historical: true,
    carriesProse: false,
  },
};

/** Every dataset id, for iteration. Ordered as declared. */
export const FILING_DATASET_IDS = Object.keys(FILING_DATASETS) as FilingDatasetId[];

/**
 * Resolve a dataset by name.
 *
 * Returns undefined for anything not in the catalogue — including strings that
 * merely look like ids. There is no fallback, no prefix match and no "did you
 * mean": a dataset that is not declared does not exist to this service.
 */
export function resolveDataset(id: string): FilingDataset | undefined {
  return Object.prototype.hasOwnProperty.call(FILING_DATASETS, id)
    ? FILING_DATASETS[id as FilingDatasetId]
    : undefined;
}

export class InvalidScopeError extends Error {}

/**
 * Build the absolute URL for a dataset and scope.
 *
 * THE SECURITY BOUNDARY OF THIS FILE. Everything a caller can influence passes
 * through here, and it is deliberately strict rather than forgiving:
 *
 *  - a `'market'` dataset takes no scope; passing one is an error, not an
 *    ignored argument, because silently dropping it would hide a caller bug
 *    that means the caller thinks it is fetching one company;
 *  - a `'symbol'` dataset requires a symbol matching `SYMBOL_PATTERN`;
 *  - the symbol is percent-encoded AFTER validation, so `M&M` survives as a
 *    symbol rather than becoming a second query parameter.
 *
 * Validate-then-encode, in that order. Encoding alone would happily encode a
 * hostile string into a working URL.
 */
export function buildUrl(dataset: FilingDataset, scope?: string): string {
  if (dataset.scope === 'market') {
    if (scope !== undefined && scope !== 'market') {
      throw new InvalidScopeError(`Dataset ${dataset.id} is market-wide and takes no symbol (received "${scope}")`);
    }
    return dataset.path('');
  }

  if (dataset.scope === 'date') {
    if (!scope) throw new InvalidScopeError(`Dataset ${dataset.id} requires a date`);
    if (!DATE_PATTERN.test(scope)) {
      throw new InvalidScopeError(`Refusing to build a URL for non-date scope "${scope}"`);
    }
    const [y, m, d] = scope.split('-');
    // Reject 2026-13-45 as well as the wrong shape: the pattern only proves
    // the digits are in the right places.
    const asDate = new Date(`${scope}T00:00:00Z`);
    if (Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== scope) {
      throw new InvalidScopeError(`Refusing to build a URL for impossible date "${scope}"`);
    }
    return dataset.path(`${d}${m}${y}`);
  }

  if (!scope) throw new InvalidScopeError(`Dataset ${dataset.id} requires a symbol`);
  if (!SYMBOL_PATTERN.test(scope)) {
    throw new InvalidScopeError(`Refusing to build a URL for non-symbol scope "${scope}"`);
  }
  return dataset.path(encodeURIComponent(scope));
}

/**
 * The XBRL document URLs found INSIDE a filing listing.
 *
 * These are the one case where a URL is not composed from the catalogue but
 * read from a payload, so it gets its own guard rather than being trusted. NSE
 * serves filing documents from `nsearchives.nseindia.com`; anything else in an
 * `xbrl` field is a redirect target we did not ask for, and is refused.
 *
 * Host-equality, not `endsWith` — `endsWith('nseindia.com')` also matches
 * `evilnseindia.com`, which is the classic form of this bug.
 */
const DOCUMENT_HOSTS = new Set(['nsearchives.nseindia.com', 'archives.nseindia.com', 'www.nseindia.com']);

export function isAllowedDocumentUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return DOCUMENT_HOSTS.has(url.hostname);
}
