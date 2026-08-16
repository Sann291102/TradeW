'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  fetchHoldings,
  fetchOrders,
  fetchPortfolio,
  fetchPositions,
  fetchTrades,
  isSignedIn,
  type OrderStatus,
} from '@/lib/oms';
import { qk } from './keys';
import { LIVE_POLL_MS, liveQueryOptions } from './live';

/**
 * The paper account: summary, positions, holdings, orders, trades.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * Three surfaces polled overlapping slices of the same account on three
 * private 5-second timers:
 *
 *   PortfolioClient   -> portfolio + positions + holdings
 *   PortfolioSummary  -> portfolio                          (dashboard card)
 *   BlotterPanel      -> positions + orders + trades        (terminal dock)
 *
 * Open the dashboard with the terminal docked and `/sim/portfolio` was fetched
 * twice and `/sim/positions` twice, every five seconds, forever — and none of
 * it stopped when the tab went to the background. Splitting the account into
 * one query per resource means each resource is fetched once no matter how
 * many components ask for it, and the shared `refetchInterval` is paused by
 * react-query whenever the window is not focused.
 *
 * Everything here is gated on `enabled` rather than early-returning, because a
 * signed-out visitor firing these can only produce 401s.
 */

/**
 * Whether this tab holds a session.
 *
 * localStorage does not exist during SSR, so reading it in render would make
 * the server and client HTML disagree. Deferring to an effect costs one render
 * at `false` and keeps hydration honest. This was copy-pasted verbatim into
 * PortfolioClient, PortfolioSummary and TodaysTrades; it lives here now so the
 * three cannot drift.
 */
export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(isSignedIn()), []);
  return signedIn;
}

export function usePortfolioSummary(enabled: boolean) {
  return useQuery({
    queryKey: qk.portfolio.summary(),
    queryFn: fetchPortfolio,
    ...liveQueryOptions({ intervalMs: LIVE_POLL_MS, enabled }),
  });
}

export function usePositions(enabled: boolean) {
  return useQuery({
    queryKey: qk.portfolio.positions(),
    queryFn: fetchPositions,
    ...liveQueryOptions({ intervalMs: LIVE_POLL_MS, enabled }),
  });
}

export function useHoldings(enabled: boolean) {
  return useQuery({
    queryKey: qk.portfolio.holdings(),
    queryFn: fetchHoldings,
    ...liveQueryOptions({ intervalMs: LIVE_POLL_MS, enabled }),
  });
}

export function useTrades(enabled: boolean) {
  return useQuery({
    queryKey: qk.portfolio.trades(),
    queryFn: fetchTrades,
    ...liveQueryOptions({ intervalMs: LIVE_POLL_MS, enabled }),
  });
}

export function useOrders(statuses: OrderStatus[] | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.orders.list(statuses),
    queryFn: () => fetchOrders(statuses),
    ...liveQueryOptions({ intervalMs: LIVE_POLL_MS, enabled }),
  });
}

/**
 * Everything a completed trading action can change.
 *
 * ── WHY ONE FUNCTION AND NOT PER-CALL-SITE INVALIDATION ────────────────────
 *
 * Placing, modifying, cancelling or exiting touches more than the list the
 * user was looking at. Cancelling an order frees margin (summary), may unwind
 * a position (positions), and drops off the blotter (orders). Before this,
 * each call site refreshed only its OWN list with a manual `setState`, so
 * cancelling from the orders tab left the portfolio value on the same screen
 * showing pre-cancellation margin until its next poll — the classic "the app
 * is lying until I reload" bug.
 *
 * Naming the whole blast radius once, here, means a new mutation gets it right
 * by calling one function instead of by remembering five keys.
 */
export function invalidateTradingData(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: qk.portfolio.all });
  void client.invalidateQueries({ queryKey: qk.orders.all });
  void client.invalidateQueries({ queryKey: qk.tradeHistory.all });
  void client.invalidateQueries({ queryKey: qk.performance.all });
}

/** Hook form, for components that need it inside an event handler. */
export function useInvalidateTradingData(): () => void {
  const client = useQueryClient();
  return () => invalidateTradingData(client);
}
