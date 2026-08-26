'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from './keys';

/**
 * Sentinel AutoTrade — the client half.
 *
 * ## The rule this file exists to honour
 *
 * §3: "Do not trust a frontend entitlement flag. The backend must enforce
 * eligibility on every relevant endpoint." So nothing here decides anything.
 * There is no `hasCapability('sentinel') && somethingElse` expression in this
 * app that gates AutoTrade; the server answers `visible` and `eligible`, and
 * the UI renders what it is told. A user who edits their session store to claim
 * a capability gets a panel that says "not available" — because the panel's
 * content came from the server too.
 *
 * ## Why enabling invalidates the trading caches
 *
 * §16 asks that Orders, Positions, Portfolio and P&L refresh when Sentinel
 * acts, using whatever mechanism the app already has. That mechanism is React
 * Query's cache, so switching AutoTrade on sweeps those prefixes: the first
 * agent order can land within a tick, and a blotter that only refreshes on
 * navigation would show the user an account that has already moved.
 */

export interface AutoTradeCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface AutoTradeQualification {
  passed: boolean;
  evaluatedAt: string;
  metrics: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netPnl: number;
    maxDrawdownPct: number;
    maxLosingStreak: number;
    tradingDays: number;
  };
  results: { id: string; label: string; met: boolean; required: number; actual: number | null; detail: string }[];
  unmet: { id: string; label: string; detail: string }[];
}

export interface AutoTradeStatus {
  /** Whether the capability should be presented at all. */
  visible: boolean;
  /** Whether it can be switched on right now. */
  eligible: boolean;
  autoTradeEnabled: boolean;
  environment: 'PAPER' | 'LIVE' | null;
  state: string | null;
  checks: AutoTradeCheck[];
  reason: string | null;
  failedCheckId: string | null;
  profileId: string | null;
  profile: {
    id: string;
    name: string;
    agent: string;
    symbol: string;
    strategyName: string | null;
    state: string;
    stateLabel: string;
    stateDescription: string;
    environment: string;
    lots: number;
    maxOrdersPerDay: number;
    maxOpenPositions: number;
    lastRunAt: string | null;
    lastDecisionAt: string | null;
    lastOrderAt: string | null;
    lastFillAt: string | null;
  } | null;
  today: { decisions: number; orders: number; trades: number; wins: number; losses: number; winRate: number | null; realizedPnl: number } | null;
  performance: { trades: number; wins: number; losses: number; winRate: number | null; realizedPnl: number } | null;
  qualification: AutoTradeQualification | null;
}

/**
 * The AutoTrade panel's single read.
 *
 * Polled on a 20 s cadence rather than subscribed: the numbers move on the
 * execution loop's own tick (60 s by default), so a socket would deliver the
 * same value three times between changes. `refetchOnWindowFocus` covers the
 * case that actually matters to a person — coming back to the tab.
 */
export function useAutoTradeStatus(enabled = true) {
  return useQuery<AutoTradeStatus>({
    queryKey: qk.autoTrade.status(),
    queryFn: () => api('/autotrade/status'),
    enabled,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    // A 403/404 here is an ANSWER, not a transient fault, and retrying it three
    // times just delays the panel's "not available" state by a few seconds.
    retry: 1,
  });
}

export function useSetAutoTrade() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api('/autotrade/enabled', { method: 'POST', body: JSON.stringify({ enabled }) }) as Promise<AutoTradeStatus>,
    onSuccess: (data) => {
      client.setQueryData(qk.autoTrade.status(), data);
      // The trading surfaces, because an agent order lands in the SAME tables
      // these read — there is no separate agent ledger to keep in step.
      client.invalidateQueries({ queryKey: qk.orders.all });
      client.invalidateQueries({ queryKey: qk.portfolio.all });
      client.invalidateQueries({ queryKey: qk.performance.all });
      client.invalidateQueries({ queryKey: qk.tradeHistory.all });
    },
  });
}
