'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { JournalEntry, ObserveResponse, SessionSummaryData, StrategyMode } from './types';

/**
 * Sentinel's default confidence gate for the workspace (Phase 3). Insights and
 * side-in-focus below this are held back as "Waiting for stronger confirmation"
 * rather than shown weak. Kept here as the single source of truth so the gate
 * the UI enforces matches the threshold observe was run with.
 */
export const SENTINEL_CONFIDENCE_THRESHOLD = 72;

export interface SentinelFocus {
  strategyMode?: StrategyMode;
  /** registry strategy ids to track simultaneously when strategyMode === 'manual' (Phase 2, multi-strategy) */
  selectedStrategyIds?: string[];
}

/**
 * Why the workspace has no observation to show.
 *
 * There is deliberately no demo/sample fallback. Rendering canned DEMO data
 * on failure meant an expired session, an API outage and a dead Sentinel
 * service all looked like a working product — and the banner told every one
 * of them "sign in for live analysis", which was wrong in two cases out of
 * three. Sentinel now shows nothing and names the actual fault.
 */
export type SentinelUnavailable =
  | { kind: 'unauthenticated' }
  | { kind: 'api-unreachable' }
  | { kind: 'service-error'; status: number; message: string };

function classify(err: unknown): SentinelUnavailable {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return { kind: 'unauthenticated' };
    return { kind: 'service-error', status: err.status, message: err.message };
  }
  // fetch itself threw — services/api is not reachable at NEXT_PUBLIC_API_URL.
  return { kind: 'api-unreachable' };
}

/**
 * Sentinel data/logic for the `/sentinel` workspace.
 * See docs/product-architecture/SENTINEL.md §5.
 *
 * `symbol` is user-centric market selection: the whole workspace re-derives
 * for whichever market the "market head" selector points at, and `/observe`
 * re-runs whenever it changes. Defaults to NIFTY.
 */
export function useSentinel(symbol: string = 'NIFTY', focus: SentinelFocus = {}) {
  const [data, setData] = useState<ObserveResponse | null>(null);
  const [summary, setSummary] = useState<SessionSummaryData | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [unavailable, setUnavailable] = useState<SentinelUnavailable | null>(null);
  const [loading, setLoading] = useState(true);

  const strategyMode = focus.strategyMode ?? 'auto';
  const selectedStrategyIds = focus.selectedStrategyIds ?? [];
  // Stable key so the effect below doesn't re-fire on every render from a new
  // array identity — only when the actual pinned set changes.
  const selectedStrategyIdsKey = selectedStrategyIds.join(',');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const observe = (await api('/sentinel/observe', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          strategyMode,
          selectedStrategyIds: strategyMode === 'manual' && selectedStrategyIds.length > 0 ? selectedStrategyIds : undefined,
          confidenceThreshold: SENTINEL_CONFIDENCE_THRESHOLD,
        }),
      })) as ObserveResponse;
      setData(observe);
      setUnavailable(null);
      try {
        setSummary((await api('/sentinel/session-summary')) as SessionSummaryData);
        setJournal((await api('/sentinel/journal?limit=10')) as JournalEntry[]);
      } catch {
        /* secondary panels degrade independently — primary observation stands */
      }
    } catch (err) {
      // No fallback data. Clear everything so no stale or canned observation
      // can be mistaken for a live read.
      setData(null);
      setSummary(null);
      setJournal([]);
      setUnavailable(classify(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, strategyMode, selectedStrategyIdsKey]);

  useEffect(() => {
    void refresh();
    // Live feed: re-run the observation on a cadence so the dashboard tracks
    // the market as it moves (the agents run server-side; this pulls their
    // latest read). /observe is cached server-side on an unchanged-market
    // draft, so a 45s poll is cheap. Paused when the tab is hidden to avoid
    // needless work, and the backend still returns the honest pre-market /
    // closed state outside session hours rather than stale "live" numbers.
    const POLL_MS = 45_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || typeof document === 'undefined' || document.hidden) return;
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void refresh();
        start();
      }
    };
    start();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  /**
   * Returns false when the entry could not be persisted. The previous
   * behaviour pushed a local-only entry into the list on failure, so the
   * trader saw a journal entry that did not exist on the server.
   */
  const addJournal = useCallback(async (content: string, mood: string): Promise<boolean> => {
    if (!content.trim()) return false;
    try {
      await api('/sentinel/journal', { method: 'POST', body: JSON.stringify({ content, mood }) });
      setJournal((await api('/sentinel/journal?limit=10')) as JournalEntry[]);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { data, summary, journal, unavailable, loading, refresh, addJournal };
}
