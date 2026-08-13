'use client';

import { useEffect, useState } from 'react';
import { fetchDhanExpiryList } from '@/lib/dhanLiveFeed';
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
 */
export function useExpiries(symbol: string, enabled = true): ExpiriesResult {
  const [state, setState] = useState<ExpiriesResult>({ status: 'loading', expiries: [], nearest: null });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading', expiries: [], nearest: null });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', expiries: [], nearest: null });

    void (async () => {
      const list = await fetchDhanExpiryList(symbol);
      if (cancelled) return;
      const todayIso = new Date().toISOString().slice(0, 10);
      const upcoming = list.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= todayIso).sort();
      if (upcoming.length === 0) {
        setState({ status: 'unavailable', expiries: [], nearest: null });
        return;
      }
      setState({
        status: 'ready',
        expiries: upcoming,
        // The same selection rule the rest of Sentinel uses, rather than a
        // second opinion about what "nearest" means.
        nearest: pickNearestExpiry(upcoming, todayIso),
      });
    })();

    return () => {
      cancelled = true;
    };
    // Expiry lists change once a week at most; no polling.
  }, [symbol, enabled]);

  return state;
}
