'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DEMO, DEMO_JOURNAL, DEMO_SUMMARY, type JournalEntry, type ObserveResponse, type SessionSummaryData } from './types';

/**
 * Sentinel data/logic — extracted verbatim from the original `/sentinel`
 * page so behavior (both live endpoints + demo-mode fallback) is unchanged
 * across the shared-shell migration. See docs/product-architecture/SENTINEL.md §5.
 */
export function useSentinel() {
  const [data, setData] = useState<ObserveResponse | null>(null);
  const [summary, setSummary] = useState<SessionSummaryData | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const observe = (await api('/sentinel/observe', { method: 'POST', body: JSON.stringify({ symbol: 'NIFTY' }) })) as ObserveResponse;
      setData(observe);
      setDemoMode(false);
      try {
        setSummary((await api('/sentinel/session-summary')) as SessionSummaryData);
        setJournal((await api('/sentinel/journal?limit=10')) as JournalEntry[]);
      } catch {
        /* secondary panels degrade independently */
      }
    } catch {
      // API offline or not signed in — render the workspace with sample data
      setData(DEMO);
      setSummary(DEMO_SUMMARY);
      setJournal(DEMO_JOURNAL);
      setDemoMode(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addJournal = useCallback(async (content: string, mood: string) => {
    if (!content.trim()) return;
    try {
      await api('/sentinel/journal', { method: 'POST', body: JSON.stringify({ content, mood }) });
      setJournal((await api('/sentinel/journal?limit=10')) as JournalEntry[]);
    } catch {
      setJournal((j) => [{ id: `local-${Date.now()}`, mood, content, flaggedByAi: false, createdAt: new Date().toISOString() }, ...j]);
    }
  }, []);

  return { data, summary, journal, demoMode, loading, refresh, addJournal };
}
