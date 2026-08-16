'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchStrategyPerformance, listWatches } from './sentinelPy';
import type { StrategyPerformance, WatchSummary } from './sentinelPy';
import { buildSessionStats, strategyIdsOf, EMPTY_SESSION_STATS, type SessionStatsModel } from './sessionStats';

/**
 * The live figures behind the session-stats tiles.
 *
 * Polls on the same 10s cadence as the strategy feed rather than the
 * dashboard's 45s `/observe` poll, and deliberately so: these numbers describe
 * the user's OWN watches, which the sweep re-evaluates every 15 seconds. Tying
 * them to the slower observation poll would let a watch confirm and sit there
 * for most of a minute with the tile beside it still reading zero — the exact
 * "the screen and the engine disagree" failure this workspace keeps hitting.
 *
 * Failure is silent by design. These are secondary figures on a page whose
 * primary content is the observation; a sentinel-py outage should leave the
 * last known numbers on screen and take nothing else down with it. `stale`
 * says the refresh failed so the panel can mark itself rather than quietly
 * present old counts as current.
 */

const POLL_MS = 10_000;

export interface SessionStatsState {
  stats: SessionStatsModel;
  watches: WatchSummary[];
  /** True until the first response lands — distinct from "loaded and empty". */
  loading: boolean;
  /** The most recent refresh failed; everything above is the last good read. */
  stale: boolean;
}

export function useSessionStats(): SessionStatsState {
  const [state, setState] = useState<SessionStatsState>({
    stats: EMPTY_SESSION_STATS,
    watches: [],
    loading: true,
    stale: false,
  });

  // Guards a slow response from overwriting a newer one after a remount or a
  // poll that overtook its predecessor.
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const watches = await listWatches();
      const ids = strategyIdsOf(watches);

      // One request per DISTINCT strategy, not per watch: the funnel already
      // counts every watch that ran on a strategy, so a per-watch fetch would
      // count the same outcomes once per watch sharing it.
      const settled = await Promise.allSettled(ids.map((id) => fetchStrategyPerformance(id)));
      if (mine !== ticket.current) return;

      const performances = settled
        .filter((r): r is PromiseFulfilledResult<StrategyPerformance> => r.status === 'fulfilled')
        .map((r) => r.value);

      setState({
        stats: buildSessionStats(watches, performances),
        watches,
        loading: false,
        // A strategy whose performance could not be read is missing from the
        // totals, so the figures are understated rather than wrong — say so.
        stale: performances.length < ids.length,
      });
    } catch {
      if (mine !== ticket.current) return;
      setState((prev) => ({ ...prev, loading: false, stale: true }));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return state;
}
