'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchDhanExpiryList } from '@/lib/dhanLiveFeed';
import { qk } from '@/lib/query/keys';
import { pickNearestExpiry } from './optionChain';

export type ExpiryStatus = 'loading' | 'ready' | 'unavailable';

export interface ExpiriesResult {
  status: ExpiryStatus;
  /** Upcoming expiries, soonest first. Empty unless `status === 'ready'`. */
  expiries: string[];
  /** The nearest upcoming expiry — what a picker should default to. */
  nearest: string | null;
}

/**
 * The expiry dates a symbol's option chain actually has.
 *
 * Separate from `useOptionChainStrikes` because the picker needs the LIST
 * before a chain is loaded: the user chooses an expiry first, and only then is
 * there a chain worth fetching. Fetching the whole chain just to learn which
 * expiries exist would be a much heavier call against a rate-limited upstream.
 *
 * Past dates are dropped by the filter below, so an already-expired contract
 * can never be picked. A symbol with no options market (commodities, most
 * ETFs) reports 'unavailable' rather than an empty dropdown with no
 * explanation.
 *
 * ── WHY THIS IS CACHED ─────────────────────────────────────────────────────
 *
 * Three surfaces ask the bridge for the same symbol's expiry list — this hook,
 * the terminal's OptionChainTab, and the learning workspace's ApplyStrategy
 * dialog. Sharing a key means the second and third are free.
 *
 * The old body was also silently unrecoverable. It ran
 * `void (async () => { const list = await fetchDhanExpiryList(symbol); … })()`
 * with NO catch, so a rejected request became an unhandled promise rejection
 * and left `status` on 'loading' forever — a spinner that could never resolve
 * and that the user had no way to retry short of a reload. A rejection is now
 * a first-class outcome: retried on the shared 429/5xx policy, and reported as
 * 'unavailable' if it survives that.
 */
export function useExpiries(symbol: string, enabled = true): ExpiriesResult {
  const query = useQuery({
    queryKey: qk.optionChain.expiries(symbol),
    queryFn: () => fetchDhanExpiryList(symbol),
    enabled,
    // Expiry lists change once a week at most, so this is reference data and
    // is deliberately not polled.
    staleTime: 60 * 60 * 1000,
  });

  if (!enabled || query.isPending) return { status: 'loading', expiries: [], nearest: null };
  if (query.isError || !query.data) return { status: 'unavailable', expiries: [], nearest: null };

  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = query.data.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= todayIso).sort();
  if (upcoming.length === 0) return { status: 'unavailable', expiries: [], nearest: null };

  return {
    status: 'ready',
    expiries: upcoming,
    // The same selection rule the rest of Sentinel uses, rather than a second
    // opinion about what "nearest" means.
    nearest: pickNearestExpiry(upcoming, todayIso),
  };
}
