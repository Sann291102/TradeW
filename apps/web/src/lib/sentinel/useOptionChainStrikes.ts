'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchDhanExpiryList, fetchDhanOptionChain } from '@/lib/dhanLiveFeed';
import { ceRows, peRows, nearestStrikeIndex, pickNearestExpiry, type StrikeRow } from './optionChain';

export type OptionChainStatus = 'loading' | 'live' | 'unavailable';

export interface OptionChainStrikes {
  status: OptionChainStatus;
  /**
   * The expiry these ladders are FOR — the one the bridge served, which is the
   * one it validated. Anything describing this chain on screen must name this
   * value and not the selection's, or it will eventually name a series the data
   * did not come from.
   */
  expiry: string | null;
  spot: number | null;
  ce: StrikeRow[];
  pe: StrikeRow[];
  /** index of the at-the-money strike within `ce`/`pe` (they share strikes), or -1 */
  atmIndex: number;
  /**
   * Epoch ms of the last SUCCESSFUL read, or null if there has never been one.
   *
   * Exists so "these strikes are still listed" can be checked before a watch is
   * started against them. `status: 'live'` alone cannot answer that: the state
   * keeps its last good ladder across a failed poll (deliberately — a blank
   * dropdown mid-session reads as "the market stopped"), so a ladder can be
   * both live-looking and minutes old. `validateWatchPair` refuses the pair
   * past `CHAIN_STALE_MS`.
   */
  fetchedAt: number | null;
}

const REFRESH_MS = 4_000;

const EMPTY: OptionChainStrikes = {
  status: 'loading',
  expiry: null,
  spot: null,
  ce: [],
  pe: [],
  atmIndex: -1,
  fetchedAt: null,
};

/**
 * Live CE/PE strike + LTP ladders for the selected market.
 *
 * Reuses the existing Dhan bridge fetchers (expiry list + option chain) — no
 * new endpoint, no new cache. Resolves the nearest expiry automatically and
 * repolls on the chain's cadence, so changing the market immediately reloads
 * the correct chain. Reports 'unavailable' (never fabricated strikes) for
 * markets with no options chain (commodities, some stocks) or when the bridge
 * is unreachable, so the panel can say so honestly.
 *
 * `enabled` gates all network activity: the panel passes `false` while it is
 * collapsed so a closed panel costs nothing.
 *
 * `expiryOverride` pins the chain to an expiry the user picked (the watch
 * creation flow lets them choose one) instead of resolving the nearest. When
 * it is undefined the nearest-expiry behaviour is unchanged; when it is null
 * the caller has an expiry picker that has not resolved yet, and nothing is
 * fetched rather than briefly loading a different expiry's ladder.
 */
export function useOptionChainStrikes(
  symbol: string,
  enabled: boolean,
  expiryOverride?: string | null,
): OptionChainStrikes {
  const [state, setState] = useState<OptionChainStrikes>(EMPTY);
  /**
   * The ATM strike this hook last reported, fed back into `nearestStrikeIndex`
   * so the pick is sticky across polls. A ref rather than state: it must not
   * itself trigger a render, and the poll below reads it at call time.
   */
  const atmStrikeRef = useRef<number | null>(null);

  // undefined = resolve the nearest expiry ourselves; null = a caller-owned
  // picker has not chosen one yet.
  const pinnedExpiry = expiryOverride;

  useEffect(() => {
    if (!enabled || pinnedExpiry === null) {
      setState(EMPTY);
      atmStrikeRef.current = null;
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setState((s) => ({ ...s, status: 'loading' }));
    // A different market's ladder shares nothing with the previous one.
    atmStrikeRef.current = null;

    const load = async () => {
      try {
        let expiry = pinnedExpiry ?? null;
        if (expiry === null) {
          const expiries = await fetchDhanExpiryList(symbol);
          // The canonical resolver, via `pickNearestExpiry`. It judges "expired"
          // against the IST trading date; this used to pass
          // `new Date().toISOString().slice(0, 10)`, which is the UTC date and
          // is therefore YESTERDAY for every IST caller between midnight and
          // 05:30 — i.e. through the whole pre-open session, every day.
          expiry = pickNearestExpiry(expiries);
        }
        if (!expiry) {
          if (!cancelled) {
            atmStrikeRef.current = null;
            setState({ ...EMPTY, status: 'unavailable' });
          }
          return;
        }
        const chain = await fetchDhanOptionChain(symbol, expiry);
        if (cancelled) return;
        if (!chain) {
          atmStrikeRef.current = null;
          setState({ ...EMPTY, status: 'unavailable', expiry });
          return;
        }
        /**
         * From here on, the SERVED expiry — not the requested one.
         *
         * The bridge validates and can roll the request forward, so these are
         * not always the same string, and every consumer of `state.expiry`
         * (the "loading the … chain" line, the "no live chain for …" line, the
         * chart titles) is describing data that came back. Reporting the
         * request instead is how a panel came to print an expiry that no part
         * of the response had anything to do with.
         */
        const servedExpiry = chain.resolvedExpiry ?? expiry;
        const ce = ceRows(chain);
        const pe = peRows(chain);
        if (ce.length === 0 && pe.length === 0) {
          atmStrikeRef.current = null;
          setState({ ...EMPTY, status: 'unavailable', expiry: servedExpiry, spot: chain.spot });
          return;
        }
        const atmIndex = nearestStrikeIndex(ce, chain.spot, atmStrikeRef.current);
        atmStrikeRef.current = ce[atmIndex]?.strike ?? null;
        setState({
          status: 'live',
          expiry: servedExpiry,
          spot: chain.spot,
          ce,
          pe,
          atmIndex,
          // Stamped only on a real ladder. The failure branches above leave it
          // at null, so "never read" and "read a while ago" stay distinct.
          fetchedAt: Date.now(),
        });
      } catch {
        if (!cancelled) {
          atmStrikeRef.current = null;
          setState({ ...EMPTY, status: 'unavailable' });
        }
      }
    };

    void load();
    // Skip the request while the tab is hidden, but keep the timer so a
    // returning trader is current within one cycle. `enabled` already stops
    // this entirely for a collapsed panel; this covers the other case the
    // audit found — a visible panel in a BACKGROUND tab, which was polling a
    // rate-limited upstream every 4 seconds for a screen nobody was looking at.
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [symbol, enabled, pinnedExpiry]);

  return state;
}
