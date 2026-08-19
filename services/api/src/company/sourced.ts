/**
 * The provenance envelope every company-intelligence value travels in.
 *
 * ── WHY EVERY NUMBER IS WRAPPED ────────────────────────────────────────────
 * The research page this replaces rendered `₹2,945.20` with no indication that
 * the figure was a hard-coded fallback, and a market cap that was `price * 670`.
 * Nothing in the response shape made that visible, so nothing downstream could
 * have caught it.
 *
 * A bare number cannot say when it was true, where it came from, or whether it
 * is live. Those are exactly the questions a research surface has to answer
 * (plan §19, §20, §33), and answering them later means retrofitting them onto
 * every field. So the envelope is the default and a bare value is the exception.
 *
 * ── `unavailable` IS A REAL ANSWER ─────────────────────────────────────────
 * `{ value: null, status: 'unavailable' }` is a first-class outcome, not an
 * error path. "We have no 52-week range for this company because we hold no
 * price history for it" is true of 198 listed companies today, and saying so is
 * strictly better than a zero, a dash, or an omitted field that a client
 * renders as blank and a user reads as ₹0.00.
 */

export type SourcedStatus =
  /** A live feed value, currently streaming. */
  | 'live'
  /** Real but lagged by a known interval. */
  | 'delayed'
  /** An end-of-day figure — correct as of the last close, not of now. */
  | 'eod'
  /** Taken from a filed document, correct for its period. */
  | 'filing'
  /** Computed by us from other sourced values. */
  | 'derived'
  /** Real, but older than its freshness budget. Never rendered as current. */
  | 'stale'
  /** We hold nothing. Not an error. */
  | 'unavailable';

export interface SourceRef {
  provider: string;
  /** 1 = exchange/regulator, 2 = free or licensed provider, 3 = secondary. */
  tier: 1 | 2 | 3;
  url?: string;
}

export interface Sourced<T> {
  value: T | null;
  status: SourcedStatus;
  source?: SourceRef;
  /** When we read it. */
  retrievedAt?: string;
  /** When the source says it was true — the instant a freshness label is computed from. */
  effectiveAt?: string;
  periodStart?: string;
  periodEnd?: string;
  frequency?: 'realtime' | 'intraday' | 'eod' | 'quarterly' | 'annual';
  /** Anything a consumer should render a warning against. */
  flags?: string[];
}

/** The answer when we genuinely hold nothing. */
export function unavailable<T>(reason?: string): Sourced<T> {
  return { value: null, status: 'unavailable', ...(reason ? { flags: [reason] } : {}) };
}

export const NSE_BHAVCOPY: SourceRef = {
  provider: 'NSE bhavcopy',
  tier: 1,
  url: 'https://www.nseindia.com/all-reports',
};

/**
 * Wrap an end-of-day value.
 *
 * `effectiveAt` is the SESSION the figure describes, which is not the moment we
 * fetched it — reading Friday's close on Sunday does not make it Sunday's
 * price. `staleAfterDays` decides when an EOD value stops being presentable as
 * the latest close: a week of silence means either a long holiday or a broken
 * ingest, and both should be visible rather than smoothed over.
 */
export function eod<T>(value: T, sessionDate: Date, staleAfterDays = 7): Sourced<T> {
  const ageDays = (Date.now() - sessionDate.getTime()) / 86_400_000;
  return {
    value,
    status: ageDays > staleAfterDays ? 'stale' : 'eod',
    source: NSE_BHAVCOPY,
    effectiveAt: sessionDate.toISOString(),
    frequency: 'eod',
    ...(ageDays > staleAfterDays ? { flags: [`last session was ${Math.floor(ageDays)} days ago`] } : {}),
  };
}

/** Wrap a value we computed ourselves from sourced inputs. */
export function derived<T>(value: T, over: { periodStart?: Date; periodEnd?: Date; flags?: string[] }): Sourced<T> {
  return {
    value,
    status: 'derived',
    source: NSE_BHAVCOPY,
    ...(over.periodStart ? { periodStart: over.periodStart.toISOString() } : {}),
    ...(over.periodEnd ? { periodEnd: over.periodEnd.toISOString() } : {}),
    ...(over.flags?.length ? { flags: over.flags } : {}),
  };
}
