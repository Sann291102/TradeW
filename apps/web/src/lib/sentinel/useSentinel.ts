'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { playNotificationSound } from '@/lib/notificationSound';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { classifyFault, type SentinelUnavailable } from './faults';
import type { JournalEntry, ObserveResponse, SessionSummaryData, StrategyMode } from './types';

export type { SentinelUnavailable };

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

  // Signature of the last observation set we've already surfaced. The live feed
  // is a poll, so "new text arrived" means: this poll's observations differ from
  // the previous one. A ref (not state) so updating it never re-renders, and it
  // survives across polls. `feedPrimed` suppresses the chime on the very first
  // load — the initial batch is not "new", it's just what was already there.
  const feedSignature = useRef<string>('');
  const feedPrimed = useRef(false);

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

      // Live-feed sound: ring the TradeW mark when the observation feed gains
      // genuinely new text. Signature = the synthesis narrative + each
      // observation's content, so a re-poll that returns the same read stays
      // silent. Skipped on the first primed load and when the operator has muted.
      const signature = `${observe.synthesis?.content ?? ''}||${(observe.observations ?? []).map((o) => `${o.createdAt ?? ''}:${o.content}`).join('|')}`;
      if (feedPrimed.current && signature !== feedSignature.current && (observe.observations?.length ?? 0) > 0) {
        if (!useWorkspaceStore.getState().notificationsMuted) playNotificationSound();
      }
      feedSignature.current = signature;
      feedPrimed.current = true;
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
      setUnavailable(classifyFault(err));
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
