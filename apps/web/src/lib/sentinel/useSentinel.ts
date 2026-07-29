'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { JournalEntry, ObserveResponse, SessionSummaryData } from './types';

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
export function useSentinel(symbol: string = 'NIFTY') {
  const [data, setData] = useState<ObserveResponse | null>(null);
  const [summary, setSummary] = useState<SessionSummaryData | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [unavailable, setUnavailable] = useState<SentinelUnavailable | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const observe = (await api('/sentinel/observe', { method: 'POST', body: JSON.stringify({ symbol }) })) as ObserveResponse;
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
  }, [symbol]);

  useEffect(() => {
    void refresh();
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
