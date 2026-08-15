'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchDhanExpiryList, fetchDhanOptionChain } from '@/lib/dhanLiveFeed';
import { ceRows, peRows, nearestStrikeIndex, pickNearestExpiry, type StrikeRow } from './optionChain';

export type OptionChainStatus = 'loading' | 'live' | 'unavailable';

export interface OptionChainStrikes {
  status: OptionChainStatus;
  expiry: string | null;
  spot: number | null;
  ce: StrikeRow[];
  pe: StrikeRow[];
  /** index of the at-the-money strike within `ce`/`pe` (they share strikes), or -1 */
  atmIndex: number;
}

const REFRESH_MS = 4_000;

const EMPTY: OptionChainStrikes = { status: 'loading', expiry: null, spot: null, ce: [], pe: [], atmIndex: -1 };

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
          const todayIso = new Date().toISOString().slice(0, 10);
          expiry = pickNearestExpiry(expiries, todayIso);
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
        const ce = ceRows(chain);
        const pe = peRows(chain);
        if (ce.length === 0 && pe.length === 0) {
          atmStrikeRef.current = null;
          setState({ ...EMPTY, status: 'unavailable', expiry, spot: chain.spot });
          return;
        }
        const atmIndex = nearestStrikeIndex(ce, chain.spot, atmStrikeRef.current);
        atmStrikeRef.current = ce[atmIndex]?.strike ?? null;
        setState({
          status: 'live',
          expiry,
          spot: chain.spot,
          ce,
          pe,
          atmIndex,
        });
      } catch {
        if (!cancelled) {
          atmStrikeRef.current = null;
          setState({ ...EMPTY, status: 'unavailable' });
        }
      }
    };

    void load();
    timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [symbol, enabled, pinnedExpiry]);

  return state;
}
