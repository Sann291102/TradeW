import { api } from '../api';

/**
 * NSE institutional-data client — FII/DII flow, participant positioning,
 * market breadth, via `services/api`'s `/nse` routes.
 *
 * The fetch, the session cookies and the cache all live server-side, for the
 * same reasons `lib/news.ts` does it that way and one more that is specific to
 * this source: NSE requires a primed cookie session and refuses browser-origin
 * requests outright, and every open tab fetching independently would multiply
 * this platform's request rate against a public exchange that can simply start
 * refusing us. One connector, one cache.
 *
 * ── READ THIS BEFORE RENDERING ANY FIGURE HERE ─────────────────────────────
 * FII/DII cash flow and participant open interest are END-OF-DAY publications.
 * The exchange computes no intraday equivalent, and no paid vendor has one
 * either — it does not exist to be bought. During market hours these numbers
 * describe the PREVIOUS session, so every one of them travels with the session
 * it belongs to and must be rendered with it. A "FII: Net Buyer" row with no
 * date on a live dashboard asserts that today's institutions have already
 * acted, which is never what this data says.
 */

export interface FiiDiiRow {
  category: 'FII' | 'DII';
  /** The completed session this describes — not today. */
  date: string;
  buy: number | null;
  sell: number | null;
  /** Buy minus sell, in ₹ crore. Positive = net buyer. */
  net: number | null;
}

export interface FiiDiiFlow {
  session: string | null;
  rows: FiiDiiRow[];
  fetchedAt: string;
}

export interface BreadthSnapshot {
  index: string;
  last: number | null;
  percentChange: number | null;
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
  fetchedAt: string;
}

export interface ParticipantOiRow {
  participant: string;
  futureIndexLong: number | null;
  futureIndexShort: number | null;
  optionIndexCallLong: number | null;
  optionIndexPutLong: number | null;
  totalLong: number | null;
  totalShort: number | null;
}

export interface ParticipantOi {
  session: string | null;
  rows: ParticipantOiRow[];
  fetchedAt: string;
}

export function fetchFiiDii(): Promise<FiiDiiFlow> {
  return api('/nse/fii-dii') as Promise<FiiDiiFlow>;
}

export function fetchBreadth(index = 'NIFTY 50'): Promise<BreadthSnapshot> {
  return api(`/nse/breadth?index=${encodeURIComponent(index)}`) as Promise<BreadthSnapshot>;
}

export function fetchParticipantOi(): Promise<ParticipantOi> {
  return api('/nse/participant-oi') as Promise<ParticipantOi>;
}

/**
 * Poll interval.
 *
 * Breadth genuinely moves through the session, so this tracks it. The
 * end-of-day figures do not move at all intraday and are served from the API's
 * own 30-minute cache regardless of how often they are asked for — the request
 * is cheap and the alternative is two cadences and two hooks for one panel.
 */
export const NSE_POLL_MS = 60_000;

/** `+1,234 Cr` / `−512 Cr`, or `—` when the session published no figure. */
export function formatCrore(value: number | null): string {
  if (value == null) return '—';
  const rounded = Math.round(value).toLocaleString('en-IN');
  return `${value >= 0 ? '+' : '−'}${rounded.replace('-', '')} Cr`;
}

/**
 * Whether a participant was a net buyer, seller, or neither.
 *
 * Returns 'flat' ONLY for an exact zero, which effectively never happens with
 * two decimal places — it exists so the caller never has to decide what a zero
 * means. A null net is not flat and is not a direction: it is no reading, and
 * the caller renders `—`.
 */
export function netStance(net: number | null): 'buyer' | 'seller' | 'flat' | null {
  if (net == null) return null;
  if (net > 0) return 'buyer';
  if (net < 0) return 'seller';
  return 'flat';
}
