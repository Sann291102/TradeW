'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchBreadth,
  fetchFiiDii,
  fetchParticipantOi,
  NSE_POLL_MS,
  type BreadthSnapshot,
  type FiiDiiFlow,
  type ParticipantOi,
} from './nse';

/**
 * The exchange-published half of market context: institutional flow,
 * institutional positioning, and real advance/decline breadth.
 *
 * Each of the three degrades independently. They are separate publications
 * with separate failure modes — the archive CSV is routinely absent for the
 * current day until well after the close, which is normal rather than a fault
 * — so one being unavailable must not blank the other two. `Promise.allSettled`
 * rather than `all` for exactly that reason.
 *
 * Nothing here is required for the dashboard to function; it is context beside
 * an observation. So a total NSE outage leaves the rest of the page untouched
 * and this panel says what it could not read.
 */

export interface NseContextState {
  flow: FiiDiiFlow | null;
  breadth: BreadthSnapshot | null;
  positioning: ParticipantOi | null;
  loading: boolean;
  /** True once at least one of the three has failed on the latest attempt. */
  degraded: boolean;
}

export function useNseContext(index = 'NIFTY 50'): NseContextState {
  const [state, setState] = useState<NseContextState>({
    flow: null,
    breadth: null,
    positioning: null,
    loading: true,
    degraded: false,
  });

  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    const [flow, breadth, positioning] = await Promise.allSettled([
      fetchFiiDii(),
      fetchBreadth(index),
      fetchParticipantOi(),
    ]);
    if (mine !== ticket.current) return;

    setState((prev) => ({
      // A failed refresh keeps the last good reading rather than dropping to
      // null. Every one of these carries `fetchedAt`, so "old" stays legible
      // downstream — which is the only reason keeping it is honest.
      flow: flow.status === 'fulfilled' ? flow.value : prev.flow,
      breadth: breadth.status === 'fulfilled' ? breadth.value : prev.breadth,
      positioning: positioning.status === 'fulfilled' ? positioning.value : prev.positioning,
      loading: false,
      degraded: [flow, breadth, positioning].some((r) => r.status === 'rejected'),
    }));
  }, [index]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), NSE_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return state;
}
