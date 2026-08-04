'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { WorkspacePayload } from './types';

/**
 * Why the workspace has no payload to render.
 *
 * Mirrors `useSentinel`'s deliberate absence of a demo fallback: rendering
 * canned data on failure made an expired session, an API outage and a dead
 * service all look like a working product. Each fault is named for what it
 * actually is.
 */
export type WorkspaceUnavailable =
  | { kind: 'unauthenticated' }
  | { kind: 'api-unreachable' }
  | { kind: 'no-market-data'; message: string }
  | { kind: 'service-error'; status: number; message: string };

function classify(err: unknown): WorkspaceUnavailable {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return { kind: 'unauthenticated' };
    // 503 is specifically "Sentinel has no real market data for this symbol",
    // which is a different problem from a crash and gets its own message.
    if (err.status === 503) return { kind: 'no-market-data', message: err.message };
    return { kind: 'service-error', status: err.status, message: err.message };
  }
  return { kind: 'api-unreachable' };
}

export interface WorkspaceQuery {
  symbol: string;
  timeframe: string;
  strike?: number;
  right?: 'CE' | 'PE';
  indicators?: string[];
  /** Free-text question. When present the service parses it and it wins. */
  query?: string;
  /**
   * Auto-refresh interval in ms. `0` (default) disables it — a caller that
   * wants a one-shot fetch should not pay for a background poller.
   *
   * Deliberately NOT a per-tick subscription. Each refresh re-runs the full
   * ten-agent reasoning pipeline server-side; polling every market tick would
   * multiply that cost by the tick rate for no benefit an intraday trader
   * would notice, and fights this codebase's own "notify on real signal, not
   * every tick" design (see the Sentinel Live Safety Feed). 30-60s keeps the
   * chart visibly live against the underlying REST candle series — which
   * itself reflects the live Dhan feed within seconds — without hammering the
   * engine.
   */
  autoRefreshMs?: number;
}

/**
 * Loads the three synchronized panels.
 *
 * One request returns all three, which is what makes them synchronized: chart,
 * option chain and annotations are all derived from a single reasoning run
 * against a single candle series. Three panels fetching independently on their
 * own timers would drift, and the annotations would describe a chart the user
 * is no longer looking at.
 */
export function useStrategyWorkspace(request: WorkspaceQuery) {
  const [data, setData] = useState<WorkspacePayload | null>(null);
  const [unavailable, setUnavailable] = useState<WorkspaceUnavailable | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  const { symbol, timeframe, strike, right, query, autoRefreshMs = 0 } = request;
  // Arrays are new objects on every render, so the identity of `indicators`
  // cannot be a dependency without re-fetching on every keystroke elsewhere.
  const indicatorKey = (request.indicators ?? []).join(',');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = (await api('/sentinel-intelligence/workspace', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          timeframe,
          strike,
          right,
          indicators: indicatorKey ? indicatorKey.split(',') : undefined,
          query,
        }),
      })) as WorkspacePayload;
      setData(payload);
      setUnavailable(null);
      setLastFetchedAt(Date.now());
    } catch (err) {
      // Clear everything so a stale payload can never be mistaken for a live
      // read of the symbol the user just switched to.
      setData(null);
      setUnavailable(classify(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe, strike, right, indicatorKey, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const interval = setInterval(() => {
      // Skip a backgrounded tab: an interval that keeps firing on a hidden tab
      // burns the reasoning engine's ten agents for a view nobody is watching.
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    }, autoRefreshMs);
    return () => clearInterval(interval);
  }, [autoRefreshMs, refresh]);

  return { data, unavailable, loading, refresh, lastFetchedAt };
}
