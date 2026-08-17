'use client';

import { useQuery } from '@tanstack/react-query';
import { ExpiryListUnreadableError, fetchDhanExpiryList } from '@/lib/dhanLiveFeed';
import { qk } from '@/lib/query/keys';
import { pickNearestExpiry } from './optionChain';

/**
 * ── WHY THERE ARE FOUR OF THESE AND NOT THREE ─────────────────────────────
 *
 * `'unavailable'` used to mean two different things: "this instrument has no
 * options market" and "the expiry list could not be read". Those need different
 * sentences on screen, and with one status there was only one sentence — so the
 * watch creator printed "NIFTY has no live option chain" during the 2026-08-17
 * credential outage, immediately followed by its own hint that NIFTY has one.
 *
 * `'none'` is a fact about the instrument. `'unreadable'` is a fact about us.
 */
export type ExpiryStatus = 'loading' | 'ready' | 'none' | 'unreadable';

export interface ExpiriesResult {
  status: ExpiryStatus;
  /** Upcoming expiries, soonest first. Empty unless `status === 'ready'`. */
  expiries: string[];
  /** The nearest upcoming expiry — what a picker should default to. */
  nearest: string | null;
  /** Why the list could not be read. Set only when `status === 'unreadable'`. */
  unreadableReason: string | null;
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

  if (!enabled || query.isPending) {
    return { status: 'loading', expiries: [], nearest: null, unreadableReason: null };
  }

  // A rejected query is a FAILED READ, never a statement about the instrument.
  // `fetchDhanExpiryList` throws `ExpiryListUnreadableError` for exactly this,
  // carrying the reason the bridge gave.
  if (query.isError || !query.data) {
    return {
      status: 'unreadable',
      expiries: [],
      nearest: null,
      unreadableReason:
        query.error instanceof ExpiryListUnreadableError
          ? query.error.reason
          : 'The option-chain feed could not be read right now.',
    };
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = query.data.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= todayIso).sort();
  // A successful read with no upcoming expiries IS Dhan's answer that this
  // instrument has no options market. That is the only path to 'none'.
  if (upcoming.length === 0) return { status: 'none', expiries: [], nearest: null, unreadableReason: null };

  return {
    status: 'ready',
    expiries: upcoming,
    // The same selection rule the rest of Sentinel uses, rather than a second
    // opinion about what "nearest" means.
    nearest: pickNearestExpiry(upcoming, todayIso),
    unreadableReason: null,
  };
}
