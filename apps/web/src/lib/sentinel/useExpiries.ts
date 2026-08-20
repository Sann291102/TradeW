'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { liveExpiries, resolveActiveExpiry } from '@tradew/types';
import { ExpiryListUnreadableError, fetchDhanExpiryList } from '@/lib/dhanLiveFeed';
import { qk } from '@/lib/query/keys';
import { useTradingDate } from './useTradingDate';

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
  /**
   * Upcoming expiries, soonest first, normalised to ISO `YYYY-MM-DD`. Empty
   * unless `status === 'ready'`.
   *
   * Referentially STABLE across renders while the underlying list and the
   * trading date are unchanged. It used to be rebuilt in the hook body on every
   * render, which made this whole object a new identity every time — and since
   * `WatchContext` puts it in a `useMemo` dependency list, that re-rendered the
   * entire workspace on every render and would have made any effect keyed on it
   * fire in a loop.
   */
  expiries: string[];
  /** The nearest upcoming expiry — what a picker should default to. */
  nearest: string | null;
  /** Why the list could not be read. Set only when `status === 'unreadable'`. */
  unreadableReason: string | null;
  /**
   * The IST trading date this list was filtered against, ticking on its own.
   *
   * Exposed so consumers judge "expired" against the SAME date this hook did.
   * A consumer reading the clock itself is how two parts of one screen end up
   * on two different days — the same class of split this module's resolver
   * exists to close, one field down.
   */
  tradingDate: string;
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
  /**
   * Ticks once per IST midnight. This is what makes an overnight page roll over
   * on its own: the filter below re-runs against the new date and drops the
   * series that expired while the tab sat open, with no request and no reload.
   */
  const tradingDate = useTradingDate();

  const query = useQuery({
    queryKey: qk.optionChain.expiries(symbol),
    queryFn: () => fetchDhanExpiryList(symbol),
    enabled,
    // Expiry lists are reference data — a new weekly series appears once a
    // week. But "once a week" is not "never", and this used to be fetched
    // exactly once per mount, so a session open across the weekly listing never
    // saw the new series at all.
    staleTime: 60 * 60 * 1000,
    /**
     * A quarter-hourly refetch, which is what "integrate with the existing
     * polling lifecycle rather than adding traffic" comes to here. Note what
     * this is NOT paying for: the DATE rolling over is handled by the ticker
     * above at zero cost. This exists only for the list itself CHANGING — a
     * series being listed or delisted upstream — and even then the bridge holds
     * a 5-minute cache in front of Dhan, so the marginal upstream cost is at
     * most a handful of calls an hour against a route that is otherwise idle.
     * The option-chain poll beside it runs every 4 seconds.
     */
    refetchInterval: 15 * 60 * 1000,
    // A tab that has been in the background all night is the case the report
    // named. Coming back to it should re-read the list, not trust an
    // overnight-old one.
    refetchOnWindowFocus: true,
  });

  const data = query.data;

  /**
   * The live list, computed ONCE per (response, trading date) rather than per
   * render — see the stability note on `ExpiriesResult.expiries`. Both inputs
   * are in the dependency list because both can change the answer: a new
   * response adds or removes a series, and a new trading date expires one.
   */
  const upcoming = useMemo(() => (data ? liveExpiries(data, tradingDate) : []), [data, tradingDate]);

  const nearest = useMemo(
    () =>
      upcoming.length === 0
        ? null
        : // The SAME resolver the rest of the flow uses, with no request to
          // honour — never a second local opinion about what "nearest" means.
          resolveActiveExpiry({ symbol, availableExpiries: upcoming, currentTime: Date.now() }).value,
    [symbol, upcoming],
  );

  return useMemo<ExpiriesResult>(() => {
    if (!enabled || query.isPending) {
      return { status: 'loading', expiries: [], nearest: null, unreadableReason: null, tradingDate };
    }

  // A rejected query is a FAILED READ, never a statement about the instrument.
  // `fetchDhanExpiryList` throws `ExpiryListUnreadableError` for exactly this,
  // carrying the reason the bridge gave.
    if (query.isError || !data) {
      return {
        status: 'unreadable',
        expiries: [],
        nearest: null,
        unreadableReason:
          query.error instanceof ExpiryListUnreadableError
            ? query.error.reason
            : 'The option-chain feed could not be read right now.',
        tradingDate,
      };
    }

    // A successful read with no upcoming expiries IS Dhan's answer that this
    // instrument has no options market. That is the only path to 'none'.
    //
    // ⚠️ Note the asymmetry this preserves: a list that arrived non-empty and
    // has since been emptied BY THE DATE FILTER (every listed series expired)
    // reports 'none' too. That is correct — there is nothing live to watch
    // either way — and the auto-roll upstream of this never fabricates a
    // replacement for it.
    if (upcoming.length === 0) {
      return { status: 'none', expiries: [], nearest: null, unreadableReason: null, tradingDate };
    }

    return {
      status: 'ready',
      expiries: upcoming,
      nearest,
      unreadableReason: null,
      tradingDate,
    };
  }, [enabled, query.isPending, query.isError, query.error, data, upcoming, nearest, tradingDate]);
}
