'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchDhanOptionChain, fetchDhanQuotes } from '@/lib/dhanLiveFeed';
import { watchLegs } from './watchState';
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
 *
 * ── BOTH LEGS ARE PRICED, 2026-08-18 ───────────────────────────────────────
 *
 * A watch names an option PAIR. This returned one number per watch, so half of
 * every pair had no live premium anywhere in the workspace — and which half
 * depended on the focused side, which the user can change. It now prices both
 * legs and keeps `focused` for the position arithmetic, which is measured
 * against the leg the user actually declared an entry on.
 *
 * This costs NO extra requests: both legs of a pair are rows in the same chain
 * response the fetch plan already retrieves once per symbol+expiry.
 */

const PRICE_POLL_MS = 10_000;

/** Both legs' last-traded premium, plus the one the position math uses. */
export interface WatchLegPrices {
  ce: number | null;
  pe: number | null;
  /**
   * The FOCUSED leg's price — the contract the user declared their entry,
   * invalidation and target against. Null when that leg has no live quote;
   * never silently substituted with the opposite leg's, which would compute an
   * R-multiple against a contract the user never took.
   */
  focused: number | null;
}

export type WatchPrices = Record<string, WatchLegPrices>;

interface ChainKey {
  symbol: string;
  expiry: string;
}

/** Distinct symbol+expiry pairs among option watches; one fetch each. */
export function chainKeys(watches: WatchSession[]): ChainKey[] {
  const seen = new Set<string>();
  const keys: ChainKey[] = [];
  for (const w of watches) {
    const legs = watchLegs(w);
    // One key per symbol+expiry serves BOTH legs of every watch on it — the
    // chain response carries the whole ladder, so pricing the pair is free
    // once the call is made.
    if ((!legs.ce && !legs.pe) || !w.expiry) continue;
    const id = `${w.symbol}|${w.expiry}`;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({ symbol: w.symbol, expiry: w.expiry });
  }
  return keys;
}

/** True when at least one watch follows an underlying rather than an option. */
export function needsQuotes(watches: WatchSession[]): boolean {
  return watches.some((w) => {
    const legs = watchLegs(w);
    return !legs.ce && !legs.pe;
  });
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
    .map((w) => {
      const legs = watchLegs(w);
      // BOTH legs are in the key. With only the focused leg here, moving the
      // put on a watch would not restart the poll and its premium would stay
      // pinned to the contract it had before.
      return [
        w.id,
        w.symbol,
        w.expiry ?? '',
        legs.ce?.strike ?? '',
        legs.pe?.strike ?? '',
        legs.focusedSide ?? '',
      ].join(':');
    })
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
            const legs = watchLegs(w);
            if (legs.ce || legs.pe) continue;
            const ltp = bySymbol.get(w.symbol);
            // An underlying watch has no legs, so the index price IS the
            // focused price and both leg slots stay honestly empty.
            if (typeof ltp === 'number') next[w.id] = { ce: null, pe: null, focused: ltp };
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
          if (w.symbol !== key.symbol || w.expiry !== key.expiry) continue;
          const legs = watchLegs(w);
          if (!legs.ce && !legs.pe) continue;

          // Each leg reads its OWN side out of its OWN strike's row. A call
          // premium can never be read off the put column or off the other
          // leg's strike, which is the same isolation the two strike pickers
          // enforce at the other end of this flow.
          const priceOf = (strike: number | undefined, side: 'ce' | 'pe') => {
            if (strike === undefined) return null;
            const ltp = byStrike.get(strike)?.[side]?.ltp;
            return typeof ltp === 'number' ? ltp : null;
          };
          const ce = priceOf(legs.ce?.strike, 'ce');
          const pe = priceOf(legs.pe?.strike, 'pe');
          const focused = legs.focusedSide === 'PE' ? pe : legs.focusedSide === 'CE' ? ce : (ce ?? pe);
          if (ce !== null || pe !== null) next[w.id] = { ce, pe, focused };
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
