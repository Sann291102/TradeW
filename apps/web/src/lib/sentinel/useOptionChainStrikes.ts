'use client';

import { useEffect, useState } from 'react';
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
 */
export function useOptionChainStrikes(symbol: string, enabled: boolean): OptionChainStrikes {
  const [state, setState] = useState<OptionChainStrikes>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setState((s) => ({ ...s, status: 'loading' }));

    const load = async () => {
      try {
        const expiries = await fetchDhanExpiryList(symbol);
        const todayIso = new Date().toISOString().slice(0, 10);
        const expiry = pickNearestExpiry(expiries, todayIso);
        if (!expiry) {
          if (!cancelled) setState({ ...EMPTY, status: 'unavailable' });
          return;
        }
        const chain = await fetchDhanOptionChain(symbol, expiry);
        if (cancelled) return;
        if (!chain) {
          setState({ ...EMPTY, status: 'unavailable', expiry });
          return;
        }
        const ce = ceRows(chain);
        const pe = peRows(chain);
        if (ce.length === 0 && pe.length === 0) {
          setState({ ...EMPTY, status: 'unavailable', expiry, spot: chain.spot });
          return;
        }
        setState({
          status: 'live',
          expiry,
          spot: chain.spot,
          ce,
          pe,
          atmIndex: nearestStrikeIndex(ce, chain.spot),
        });
      } catch {
        if (!cancelled) setState({ ...EMPTY, status: 'unavailable' });
      }
    };

    void load();
    timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [symbol, enabled]);

  return state;
}
