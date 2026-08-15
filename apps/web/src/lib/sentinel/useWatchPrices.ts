'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchDhanOptionChain, fetchDhanQuotes } from '@/lib/dhanLiveFeed';
import type { WatchSession } from './strategyApi';

/**
 * Live last-traded price for each watch, keyed by watch id.
 *
 * ## Why this is grouped rather than per-card
 *
 * Dhan's option chain API is rate limited, and the Sentinel workspace already
 * learned that lesson the hard way (see the ATM hysteresis note in
 * optionChain.ts — a chain refetch per ATM flip exhausted the limit
 * mid-session). Ten watches on the same NIFTY expiry are ONE chain call here,
 * not ten: the fetch plan is built from the distinct symbol+expiry pairs, and
 * every watch on a pair reads its own leg out of that single response.
 *
 * Watches on an underlying (no strike) come from the single `/quotes`
 * snapshot, which carries every index, stock, ETF and commodity in one call.
 *
 * A price that could not be resolved is absent from the map — never zero,
 * never the last known value from a different instrument. The cards render a
 * dash for it, which is the honest thing to show.
 */

const PRICE_POLL_MS = 10_000;

export type WatchPrices = Record<string, number>;

interface ChainKey {
  symbol: string;
  expiry: string;
}

/** Distinct symbol+expiry pairs among option watches; one fetch each. */
export function chainKeys(watches: WatchSession[]): ChainKey[] {
  const seen = new Set<string>();
  const keys: ChainKey[] = [];
  for (const w of watches) {
    if (!w.strike || !w.optionType || !w.expiry) continue;
    const id = `${w.symbol}|${w.expiry}`;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({ symbol: w.symbol, expiry: w.expiry });
  }
  return keys;
}

/** True when at least one watch follows an underlying rather than an option. */
export function needsQuotes(watches: WatchSession[]): boolean {
  return watches.some((w) => !w.strike || !w.optionType);
}

export function useWatchPrices(watches: WatchSession[]): WatchPrices {
  const [prices, setPrices] = useState<WatchPrices>({});
  // The polling effect reads the current watch list at call time, so a state
  // change on an existing watch does not restart the interval. Updated in its
  // own effect (declared first, so it runs first on mount) rather than during
  // render, which would be a side effect in the render phase.
  const watchesRef = useRef(watches);
  useEffect(() => {
    watchesRef.current = watches;
  }, [watches]);

  // Restart only when the SET of instruments changes, not on every poll that
  // returns a new array identity or a changed state field.
  const instrumentKey = watches
    .filter((w) => w.state !== 'EXITED')
    .map((w) => `${w.id}:${w.symbol}:${w.expiry ?? ''}:${w.strike ?? ''}:${w.optionType ?? ''}`)
    .sort()
    .join(',');

  useEffect(() => {
    if (!instrumentKey) {
      setPrices({});
      return;
    }
    let cancelled = false;

    const load = async () => {
      const live = watchesRef.current.filter((w) => w.state !== 'EXITED');
      const next: WatchPrices = {};

      if (needsQuotes(live)) {
        try {
          const snapshot = await fetchDhanQuotes();
          const bySymbol = new Map(
            [...snapshot.indices, ...snapshot.stocks, ...snapshot.etfs, ...snapshot.commodities].map((q) => [
              q.symbol,
              q.ltp,
            ]),
          );
          for (const w of live) {
            if (w.strike && w.optionType) continue;
            const ltp = bySymbol.get(w.symbol);
            if (typeof ltp === 'number') next[w.id] = ltp;
          }
        } catch {
          // Leave those watches priceless for this tick rather than reusing a
          // stale number as if it were current.
        }
      }

      // Sequential, not parallel: these hit the same rate-limited upstream, and
      // a burst is exactly what the limiter penalises.
      for (const key of chainKeys(live)) {
        if (cancelled) return;
        const chain = await fetchDhanOptionChain(key.symbol, key.expiry);
        if (!chain) continue;
        const byStrike = new Map(chain.strikes.map((s) => [s.strike, s]));
        for (const w of live) {
          if (w.symbol !== key.symbol || w.expiry !== key.expiry || !w.strike || !w.optionType) continue;
          const leg = byStrike.get(Number(w.strike));
          const ltp = w.optionType === 'CE' ? leg?.ce?.ltp : leg?.pe?.ltp;
          if (typeof ltp === 'number') next[w.id] = ltp;
        }
      }

      if (!cancelled) setPrices(next);
    };

    void load();
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => void load(), PRICE_POLL_MS);
    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearInterval(timer);
        timer = null;
      } else if (!timer) {
        void load();
        timer = setInterval(() => void load(), PRICE_POLL_MS);
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [instrumentKey]);

  return prices;
}
