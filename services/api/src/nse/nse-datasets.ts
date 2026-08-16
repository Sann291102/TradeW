/**
 * The NSE datasets this platform may read — a closed, named catalogue.
 *
 * ── WHY A CATALOGUE AND NOT A FETCHER ──────────────────────────────────────
 * The requirement behind this module is "let the in-app agent reach NSE for
 * institutional data". The obvious implementation — hand the agent a URL
 * parameter and let it browse nseindia.com — is the wrong shape for two
 * independent reasons, and both are already settled precedent in this repo:
 *
 *  1. **A URL parameter on a server-side fetcher is an SSRF primitive.** The
 *     broker-integration review recorded the general form of this: a `:path*`
 *     passthrough is a standing exposure regardless of what is exposed today.
 *     `services/api` sits inside the network with the database and the internal
 *     services; anything that turns a caller-supplied string into an outbound
 *     request from that position is a hole, and "but it validates the hostname"
 *     is one redirect away from not being true.
 *
 *  2. **Fetched web content is data, never instruction.** NSE's own pages carry
 *     third-party text — corporate announcements, company-authored board-meeting
 *     descriptions. If an agent browses freely, that text lands in a model
 *     context as prose. A named dataset returning parsed, typed numbers cannot
 *     carry an instruction; an HTML page can.
 *
 * So the agent gets what was actually asked for — reach into NSE for these
 * details — by naming a dataset. It never composes a URL. Adding a dataset is a
 * code change with a review, which is the point: the allowlist is the control,
 * exactly as `feed-url.ts` is for outbound links and the /feed proxy allowlist
 * is for the market-data bridge.
 *
 * Pure and dependency-free so the boundary is unit-testable on its own.
 */

/** Datasets by name. Anything not in this union does not exist to this service. */
export type NseDatasetId =
  | 'fii-dii-cash'
  | 'participant-oi'
  | 'indices'
  | 'market-status'
  | 'event-calendar'
  | 'holidays';

export interface NseDataset {
  id: NseDatasetId;
  /** What it answers, in one line — this is what the agent selects on. */
  describes: string;
  /** Absolute URL, or a builder for the date-stamped archive files. */
  path: string | ((day: string) => string);
  host: 'www.nseindia.com' | 'archives.nseindia.com';
  format: 'json' | 'csv';
  /**
   * How long a response stays fresh, in ms.
   *
   * Set by how often the SOURCE changes, not by how often a caller asks.
   * FII/DII cash and participant OI are end-of-day publications — re-fetching
   * them every minute would hammer NSE all day to receive the same row.
   */
  ttlMs: number;
  /**
   * True when the dataset describes a COMPLETED session rather than the live
   * one. Consumers must render these with their date; see `staleness` below.
   */
  endOfDay: boolean;
  /** The page a browser would be on when it requests this — NSE checks Referer. */
  referer: string;
}

const MINUTE = 60_000;

/**
 * The catalogue.
 *
 * Every entry was verified returning real data on 2026-08-16. None of them
 * needs a key, an account or a paid plan — which is the whole reason this file
 * exists rather than a vendor integration.
 */
export const NSE_DATASETS: Record<NseDatasetId, NseDataset> = {
  /**
   * FII/FPI and DII cash-market buy/sell/net in ₹ crore.
   *
   * THE FIGURE THE PRODUCT ASKED FOR — and the one whose limitation matters
   * most: it is published AFTER the close, one session at a time. There is no
   * intraday FII/DII cash number anywhere, free or paid; the exchange does not
   * compute one. A dashboard row reading "FII: Net Buyer" during market hours
   * is therefore always describing YESTERDAY, and must say so.
   */
  'fii-dii-cash': {
    id: 'fii-dii-cash',
    describes: 'FII/FPI and DII cash-market buy, sell and net turnover for the last completed session (₹ crore)',
    path: 'https://www.nseindia.com/api/fiidiiTradeReact',
    host: 'www.nseindia.com',
    format: 'json',
    ttlMs: 30 * MINUTE,
    endOfDay: true,
    referer: 'https://www.nseindia.com/reports/fii-dii',
  },

  /**
   * Participant-wise open interest in equity derivatives — Client, DII, FII,
   * Pro — as contract counts across index/stock futures and options.
   *
   * The derivatives half of the same question, and for an options product it is
   * the more useful of the two: "FII index futures long 25,537 vs short 202,235"
   * is positioning, where the cash figure is only flow.
   */
  'participant-oi': {
    id: 'participant-oi',
    describes: 'Participant-wise open interest (Client/DII/FII/Pro) in equity derivatives, in contracts',
    path: (day) => `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${day}.csv`,
    host: 'archives.nseindia.com',
    format: 'csv',
    ttlMs: 30 * MINUTE,
    endOfDay: true,
    referer: 'https://www.nseindia.com/all-reports-derivatives',
  },

  /**
   * Every NSE index with open/high/low/last plus advances, declines and
   * unchanged — real market breadth, which this platform has been reporting as
   * "not enough data yet" because nothing computed it.
   */
  indices: {
    id: 'indices',
    describes: 'All NSE indices with OHLC, percent change, and advance/decline/unchanged counts',
    path: 'https://www.nseindia.com/api/allIndices',
    host: 'www.nseindia.com',
    format: 'json',
    ttlMs: MINUTE,
    endOfDay: false,
    referer: 'https://www.nseindia.com/market-data/live-market-indices',
  },

  'market-status': {
    id: 'market-status',
    describes: 'Open/closed state of each NSE segment (capital, currency, commodity, debt) with its trade date',
    path: 'https://www.nseindia.com/api/marketStatus',
    host: 'www.nseindia.com',
    format: 'json',
    ttlMs: MINUTE,
    endOfDay: false,
    referer: 'https://www.nseindia.com/',
  },

  /**
   * Upcoming board meetings by listed company.
   *
   * Worth being precise about what this is NOT: it is a CORPORATE calendar, not
   * a macro one. It cannot tell you when US CPI prints — no NSE endpoint can,
   * and the reference design's "Upcoming: U.S CPI Data" has no free Indian
   * source at all. What it genuinely answers is "which companies report this
   * week", which is the event risk an Indian equity trader actually carries.
   */
  'event-calendar': {
    id: 'event-calendar',
    describes: 'Upcoming corporate board meetings by listed company (results, fund raising, dividends)',
    path: 'https://www.nseindia.com/api/event-calendar',
    host: 'www.nseindia.com',
    format: 'json',
    ttlMs: 6 * 60 * MINUTE,
    endOfDay: false,
    referer: 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar',
  },

  holidays: {
    id: 'holidays',
    describes: 'NSE trading holidays for the current calendar year, by segment',
    path: 'https://www.nseindia.com/api/holiday-master?type=trading',
    host: 'www.nseindia.com',
    format: 'json',
    ttlMs: 24 * 60 * MINUTE,
    endOfDay: false,
    referer: 'https://www.nseindia.com/resources/exchange-communication-holidays',
  },
};

export const NSE_DATASET_IDS = Object.keys(NSE_DATASETS) as NseDatasetId[];

/**
 * Resolve a caller-supplied name to a dataset, or null.
 *
 * The ONLY way a URL is produced in this module. A caller — including the
 * agent — supplies a name; if it is not in the catalogue nothing is fetched.
 * There is deliberately no fuzzy match, no prefix match and no fallback: a
 * near-miss must fail loudly rather than silently fetch a neighbour.
 */
export function resolveDataset(id: unknown): NseDataset | null {
  if (typeof id !== 'string') return null;
  return NSE_DATASETS[id as NseDatasetId] ?? null;
}

/**
 * The URL for a dataset, with the archive day already substituted.
 *
 * `day` is re-validated here rather than trusted from the caller even though
 * the only producer is `archiveDay()` below — this is the single point where a
 * string becomes part of a URL, so it is the single point that has to be sure.
 */
export function datasetUrl(dataset: NseDataset, day?: string): string | null {
  if (typeof dataset.path === 'string') return dataset.path;
  if (!day || !/^\d{8}$/.test(day)) return null;
  return dataset.path(day);
}

/** `DDMMYYYY`, the format NSE's archive filenames use. */
export function archiveDay(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${date.getUTCFullYear()}`;
}

/**
 * The last few candidate days for an end-of-day archive, newest first.
 *
 * Archives exist per TRADING day, so a Sunday request must walk back to Friday
 * — and the file for today does not appear until well after the close, so even
 * on a weekday the newest candidate is frequently a 404. Weekends are skipped
 * outright; holidays are not knowable here and simply 404, which the caller
 * handles by trying the next candidate.
 */
export function archiveCandidates(now: Date, count = 5): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (out.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(archiveDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}
