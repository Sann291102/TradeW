'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useEffect } from 'react';

/**
 * Lightweight persisted store for the Option Chain's "Add to Watchlist" /
 * "Add to Strategy" quick actions. Deliberately separate from the larger
 * `workspaceStore` (dock panel/layout state) — this is just two small lists
 * of contract references, not workspace continuity. No real strategy P&L
 * engine or broker-side watchlist sync here; it's the honest scope: persist
 * what the user picked, show a count, nothing more.
 */
export interface ContractKey {
  underlying: string;
  strike: number;
  optionType: 'CE' | 'PE';
  expiryLabel: string;
}

export function contractKeyOf(c: ContractKey): string {
  return `${c.underlying}-${c.strike}-${c.optionType}-${c.expiryLabel}`;
}

interface TradeBasketStore {
  watchlist: ContractKey[];
  strategyLegs: ContractKey[];
  hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
  toggleWatchlist: (c: ContractKey) => void;
  toggleStrategy: (c: ContractKey) => void;
}

export const useTradeBasketStore = create<TradeBasketStore>()(
  persist(
    (set) => ({
      watchlist: [],
      strategyLegs: [],
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),
      toggleWatchlist: (c) =>
        set((s) => {
          const key = contractKeyOf(c);
          const exists = s.watchlist.some((w) => contractKeyOf(w) === key);
          return { watchlist: exists ? s.watchlist.filter((w) => contractKeyOf(w) !== key) : [...s.watchlist, c] };
        }),
      toggleStrategy: (c) =>
        set((s) => {
          const key = contractKeyOf(c);
          const exists = s.strategyLegs.some((w) => contractKeyOf(w) === key);
          return { strategyLegs: exists ? s.strategyLegs.filter((w) => contractKeyOf(w) !== key) : [...s.strategyLegs, c] };
        }),
    }),
    {
      name: 'tradew-trade-basket-v1',
      skipHydration: true,
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    },
  ),
);

/** Mount once per consumer tree (cheap/idempotent) — triggers the localStorage
 *  rehydration client-side only, same hydration-mismatch-avoidance pattern as
 *  workspaceStore's useHydrateWorkspaceStore. */
export function useHydrateTradeBasket() {
  useEffect(() => {
    void useTradeBasketStore.persist.rehydrate();
  }, []);
}
