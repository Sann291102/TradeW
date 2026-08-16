'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { playNotificationSound } from '@/lib/notificationSound';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { splitFault, type SentinelUnavailable } from './faults';
import { sentinelKeys } from './queryKeys';
import { logIfRateLimited, pollIntervalMs } from './retryPolicy';
import type { WatchSession } from './strategyApi';
import type { JournalEntry, ObserveResponse, SessionSummaryData, StrategyMode } from './types';

export type { SentinelUnavailable };

/**
 * Sentinel's default confidence gate for the workspace (Phase 3). Insights and
 * side-in-focus below this are held back as "Waiting for stronger confirmation"
 * rather than shown weak. Kept here as the single source of truth so the gate
 * the UI enforces matches the threshold observe was run with.
 */
export const SENTINEL_CONFIDENCE_THRESHOLD = 72;

/**
 * The session summary and journal move on a human timescale — trades taken
 * today, entries the user wrote — so they are polled at a fraction of the
 * observation's cadence rather than being dragged along by it. They used to be
 * fetched INSIDE the observe request handler, which meant three calls every
 * time the market read refreshed, against three separate rate-limit buckets,
 * for two payloads that had not changed.
 */
const SLOW_PANEL_POLL_MS = 60_000;

export interface SentinelFocus {
  strategyMode?: StrategyMode;
  /** registry strategy ids to track simultaneously when strategyMode === 'manual' (Phase 2, multi-strategy) */
  selectedStrategyIds?: string[];
  /**
   * Set false to hold the observation entirely — for a surface that is mounted
   * but knows the request cannot succeed, e.g. an account without the
   * `sentinel` capability, where `/observe` can only ever return 403.
   *
   * Those 403s were not free. Rate-limit buckets in services/api are keyed by
   * IP and counted BEFORE the guards run, so a request that was always going
   * to be refused still spends budget belonging to the entitled users on the
   * same network. Defaults to true.
   */
  enabled?: boolean;
}

export interface SentinelResult {
  data: ObserveResponse | null;
  summary: SessionSummaryData | null;
  journal: JournalEntry[];
  /**
   * Set ONLY when there is nothing to show: every retry failed AND no cached
   * observation exists. A fault with cached data behind it is `reconnecting`
   * instead, because the workspace can keep rendering.
   */
  unavailable: SentinelUnavailable | null;
  /** First load, nothing on screen yet. */
  loading: boolean;
  /** A refetch is in flight over data that is already rendered. */
  refreshing: boolean;
  /**
   * The last attempt failed but cached data is still on screen. This is the
   * transient state the inline banner renders — the workspace stays up.
   */
  reconnecting: SentinelUnavailable | null;
  /** When the rendered observation was received. Null before the first one. */
  updatedAt: number | null;
  refresh: () => Promise<void>;
  addJournal: (content: string, mood: string) => Promise<boolean>;
}

/**
 * Sentinel data/logic for the `/sentinel` workspace.
 * See docs/product-architecture/SENTINEL.md §5.
 *
 * `symbol` is user-centric market selection: the whole workspace re-derives
 * for whichever market the "market head" selector points at, and `/observe`
 * re-runs whenever it changes. Defaults to NIFTY.
 *
 * ── WHY THIS IS A QUERY AND NOT A useState + useEffect ─────────────────────
 *
 * It used to be the latter, and all three of the workspace's production bugs
 * came out of that shape:
 *
 *  · ONE SHOT. `refresh()` ran on mount. If it threw — 429 from the per-IP
 *    rate limiter, 503 from a restarting service — it set `unavailable` and
 *    stopped. There was no retry, so the error was permanent for the lifetime
 *    of the component, and the only way to clear it was a full page reload.
 *    That is why reloading "fixed" it: the second attempt landed outside the
 *    rate-limit window.
 *
 *  · NO CACHE. The response lived in component state, so navigating away threw
 *    it out. Coming back re-ran the same one-shot fetch and rolled the dice
 *    again.
 *
 *  · NO DEDUPLICATION. `SentinelWorkspace` and the terminal's `SentinelPanel`
 *    both call this hook. Two mounts meant two independent `/observe` calls
 *    against a 30/min-per-IP bucket, each one making the other more likely to
 *    be the one that got refused.
 *
 * React Query fixes all three with the same mechanism: the key IS the cache
 * entry, and one key means one in-flight request no matter how many components
 * ask for it. Retry, backoff and the poll cadence come from
 * `retryPolicy.ts`; the defaults live in `lib/queryClient.ts`.
 */
export function useSentinel(symbol: string = 'NIFTY', focus: SentinelFocus = {}): SentinelResult {
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => s.user?.id ?? null);

  const enabled = focus.enabled ?? true;
  const strategyMode = focus.strategyMode ?? 'auto';
  const selectedStrategyIds = focus.selectedStrategyIds ?? [];
  // Stable key so a new array identity on every render is not a new cache
  // entry (and therefore not a new request).
  const selectedStrategyIdsKey = selectedStrategyIds.join(',');

  const observeKey = sentinelKeys.observe(userId, symbol, strategyMode, selectedStrategyIds);

  const observeQuery = useQuery({
    queryKey: observeKey,
    queryFn: async () => {
      try {
        return (await api('/sentinel/observe', {
          method: 'POST',
          body: JSON.stringify({
            symbol,
            strategyMode,
            selectedStrategyIds:
              strategyMode === 'manual' && selectedStrategyIdsKey.length > 0
                ? selectedStrategyIdsKey.split(',')
                : undefined,
            confidenceThreshold: SENTINEL_CONFIDENCE_THRESHOLD,
          }),
        })) as ObserveResponse;
      } catch (err) {
        logIfRateLimited(err, '/sentinel/observe');
        throw err;
      }
    },
    enabled,
    // Adaptive, and evaluated on every tick rather than fixed at mount: a
    // failing query backs off instead of hammering a service that is already
    // refusing it, and a user with nothing being watched does not pay the
    // active cadence for a read they are not waiting on. See retryPolicy.ts
    // for the numbers and what they cost against the rate limiter.
    refetchInterval: (query) =>
      pollIntervalMs({
        failing: query.state.status === 'error',
        hasActiveWatches: hasActiveWatches(queryClient, userId),
      }),
    // A hidden tab is not being read. `refetchOnWindowFocus` brings it current
    // the moment it comes back, so pausing here costs no freshness and stops a
    // wall of background tabs from sharing out the rate-limit budget.
    refetchIntervalInBackground: false,
  });

  const data = observeQuery.data ?? null;

  // The secondary panels degrade independently — a dead session-summary must
  // not take the observation down with it, which is why they are their own
  // queries rather than a `try/catch` inside the one above. They are also not
  // retried as hard: they are supporting detail, and the next poll is a minute
  // away rather than an outage.
  const summaryQuery = useQuery({
    queryKey: sentinelKeys.sessionSummary(userId),
    queryFn: () => api('/sentinel/session-summary') as Promise<SessionSummaryData>,
    enabled,
    refetchInterval: SLOW_PANEL_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: SLOW_PANEL_POLL_MS / 2,
  });

  const journalQuery = useQuery({
    queryKey: sentinelKeys.journal(userId),
    queryFn: () => api('/sentinel/journal?limit=10') as Promise<JournalEntry[]>,
    enabled,
    refetchInterval: SLOW_PANEL_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: SLOW_PANEL_POLL_MS / 2,
  });

  useFeedChime(data);

  const addJournalMutation = useMutation({
    mutationFn: (input: { content: string; mood: string }) =>
      api('/sentinel/journal', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sentinelKeys.journal(userId) });
    },
  });

  /**
   * Returns false when the entry could not be persisted. The previous
   * behaviour pushed a local-only entry into the list on failure, so the
   * trader saw a journal entry that did not exist on the server.
   */
  const addJournal = useCallback(
    async (content: string, mood: string): Promise<boolean> => {
      if (!content.trim()) return false;
      try {
        await addJournalMutation.mutateAsync({ content, mood });
        return true;
      } catch {
        return false;
      }
    },
    [addJournalMutation],
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      observeQuery.refetch(),
      summaryQuery.refetch(),
      journalQuery.refetch(),
    ]);
  }, [observeQuery, summaryQuery, journalQuery]);

  const split = splitFault(observeQuery.error, observeQuery.failureReason, data !== null);

  return {
    data,
    summary: summaryQuery.data ?? null,
    journal: journalQuery.data ?? [],
    unavailable: split.terminal,
    loading: enabled && observeQuery.isPending && data === null,
    refreshing: observeQuery.isFetching,
    reconnecting: split.transient,
    updatedAt: observeQuery.dataUpdatedAt || null,
    refresh,
    addJournal,
  };
}


/**
 * Reads the watch list already in cache to pick a poll cadence.
 *
 * A cache read, never a fetch: the strategy panel owns that query and is
 * mounted alongside on `/sentinel`. Surfaces that do not have it — the
 * terminal's Sentinel panel on `/trade` — simply see no active watches and
 * poll at the idle cadence, which is the right answer for them anyway.
 */
function hasActiveWatches(queryClient: QueryClient, userId: string | null): boolean {
  const watches = queryClient.getQueryData<WatchSession[]>(sentinelKeys.watches(userId));
  return Array.isArray(watches) && watches.some((w) => w.state !== 'EXITED');
}

/**
 * Live-feed sound: ring the TradeW mark when the observation feed gains
 * genuinely new text.
 *
 * Signature = the synthesis narrative + each observation's content, so a
 * re-poll that returns the same read stays silent. `primed` suppresses the
 * chime on the very first load — the initial batch is not "new", it is just
 * what was already there. Refs rather than state so updating them never
 * re-renders, and they survive across polls.
 */
function useFeedChime(data: ObserveResponse | null): void {
  const signatureRef = useRef<string>('');
  const primedRef = useRef(false);

  useEffect(() => {
    if (!data) return;
    const signature = `${data.synthesis?.content ?? ''}||${(data.observations ?? [])
      .map((o) => `${o.createdAt ?? ''}:${o.content}`)
      .join('|')}`;
    if (
      primedRef.current &&
      signature !== signatureRef.current &&
      (data.observations?.length ?? 0) > 0 &&
      !useWorkspaceStore.getState().notificationsMuted
    ) {
      playNotificationSound();
    }
    signatureRef.current = signature;
    primedRef.current = true;
  }, [data]);
}
