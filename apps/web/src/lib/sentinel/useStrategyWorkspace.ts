'use client';

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSessionStore } from '@/lib/store/sessionStore';
import { splitFault, type SentinelUnavailable } from './faults';
import { sentinelKeys } from './queryKeys';
import { logIfRateLimited, pollIntervalMs } from './retryPolicy';
import {
  archiveStrategy,
  closePosition,
  createStrategy,
  createWatch,
  listStrategies,
  listWatches,
  openPosition,
  updateStrategy,
  type CreateWatchInput,
  type OpenPositionInput,
  type ParsedStrategy,
  type StrategyStatus,
  type UserStrategy,
  type WatchSession,
} from './strategyApi';

/**
 * Data hooks for the Sentinel strategy/watch workspace.
 *
 * Two hooks rather than one, because the two halves refresh for different
 * reasons: strategies change only when the user changes them, while watch
 * state is advanced server-side by the sweep loop and has to be polled.
 *
 * Both surface failures as a `SentinelUnavailable` rather than a bare boolean,
 * so the panels can say which of "not signed in" / "not entitled" / "API down"
 * actually happened — the same rule the rest of Sentinel follows.
 *
 * ── WHY EVERY MUTATION WRITES THE CACHE AND THEN INVALIDATES ───────────────
 *
 * "I saved a strategy and it didn't appear until I reloaded" was the third
 * production bug, and it had two separate causes that both live here.
 *
 * The first was scope: the list lived in `useState` inside this hook, so a
 * mutation could only update the copy belonging to the component that called
 * it. Anything else reading strategies — and, once the page had remounted,
 * this component's own next incarnation — never heard about the write.
 *
 * The second was ordering. Writing ONLY the server response leaves the UI
 * frozen for the length of the round trip, which on a rate-limited or slow
 * connection is long enough to look broken and get clicked again. So each
 * mutation below writes the expected state into the cache immediately
 * (`onMutate`), rolls that write back if the server refuses (`onError`), and
 * invalidates on settle so the server's version is what survives. The user
 * sees the change on the next frame; the truth still comes from the server.
 */

export interface StrategiesResult {
  strategies: UserStrategy[];
  loading: boolean;
  /** Terminal: no strategies could be loaded and none are cached. */
  fault: SentinelUnavailable | null;
  /** Transient: a refetch failed but the cached list is still on screen. */
  reconnecting: SentinelUnavailable | null;
  refresh: () => Promise<void>;
  save: (input: { name: string; rawInput: string; rules: ParsedStrategy }) => Promise<UserStrategy>;
  setStatus: (id: string, status: StrategyStatus) => Promise<void>;
  archive: (id: string) => Promise<void>;
}

export function useUserStrategies(enabled = true): StrategiesResult {
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => s.user?.id ?? null);
  const key = sentinelKeys.strategies(userId);

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await listStrategies();
      } catch (err) {
        logIfRateLimited(err, '/sentinel-py/strategies');
        throw err;
      }
    },
    enabled,
    // Strategies change when the USER changes them, and every one of those
    // paths invalidates this key. Polling them would be pure rate-limit spend
    // for a list that cannot move on its own.
    refetchInterval: false,
  });

  const strategies = query.data ?? [];

  /** Replace one row in the cached list optimistically, leaving order untouched. */
  const patchRow = useCallback(
    (id: string, next: (previous: UserStrategy) => UserStrategy) =>
      optimistic<UserStrategy[]>(queryClient, key, (rows = []) => rows.map((s) => (s.id === id ? next(s) : s))),
    [queryClient, key],
  );

  /** The same replacement, from a confirmed server response. */
  const commitRow = useCallback(
    (row: UserStrategy) =>
      writeCache<UserStrategy[]>(queryClient, key, (rows = []) => rows.map((s) => (s.id === row.id ? row : s))),
    [queryClient, key],
  );

  /** Throws on failure so the form can keep the user's draft and say why. */
  const saveMutation = useMutation({
    mutationFn: createStrategy,
    onSuccess: (created) => {
      // Prepend the row the server actually returned rather than a guess: a
      // strategy has a server-assigned id and parsed rules, and inventing a
      // placeholder for those would put a strategy on screen that cannot be
      // selected or watched. The write is still immediate — this is the
      // response handler, not a refetch.
      writeCache<UserStrategy[]>(queryClient, key, (rows = []) => [created, ...rows]);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const setStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: StrategyStatus }) => updateStrategy(id, { status }),
    // Pause/resume is a one-field flip the client can predict exactly, so the
    // button state changes on the click rather than on the round trip.
    onMutate: ({ id, status }) => patchRow(id, (s) => ({ ...s, status })),
    onError: (_err, _vars, rollback) => rollback?.(),
    onSuccess: (updated) => commitRow(updated),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: archiveStrategy,
    // Kept in the list with its new status rather than dropped: the picker
    // already hides archived strategies (`selectableStrategies`), and a watch
    // card still needs to resolve this id to a NAME. Dropping the row renamed
    // every existing watch to "Strategy no longer listed".
    onMutate: (id) => patchRow(id, (s) => ({ ...s, status: 'archived' as const })),
    onError: (_err, _vars, rollback) => rollback?.(),
    onSuccess: (archived) => commitRow(archived),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const refresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const save = useCallback(
    (input: { name: string; rawInput: string; rules: ParsedStrategy }) => saveMutation.mutateAsync(input),
    [saveMutation],
  );

  const setStatus = useCallback(
    async (id: string, status: StrategyStatus) => {
      await setStatusMutation.mutateAsync({ id, status });
    },
    [setStatusMutation],
  );

  const archive = useCallback(
    async (id: string) => {
      await archiveMutation.mutateAsync(id);
    },
    [archiveMutation],
  );

  const split = splitFault(query.error, query.failureReason, strategies.length > 0);

  return {
    strategies,
    loading: query.isPending && enabled,
    fault: split.terminal,
    reconnecting: split.transient,
    refresh,
    save,
    setStatus,
    archive,
  };
}

export interface WatchesResult {
  watches: WatchSession[];
  loading: boolean;
  fault: SentinelUnavailable | null;
  reconnecting: SentinelUnavailable | null;
  refresh: () => Promise<void>;
  start: (input: CreateWatchInput) => Promise<WatchSession>;
  markEntered: (watchId: string, input: OpenPositionInput) => Promise<WatchSession>;
  markClosed: (watchId: string) => Promise<WatchSession>;
}

export function useWatchSessions(enabled = true): WatchesResult {
  const queryClient = useQueryClient();
  const userId = useSessionStore((s) => s.user?.id ?? null);
  const key = sentinelKeys.watches(userId);

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return await listWatches();
      } catch (err) {
        logIfRateLimited(err, '/sentinel-py/watch');
        throw err;
      }
    },
    enabled,
    // Unlike strategies, watch state is advanced by the server's sweep loop
    // and the browser has no push channel for it, so this one genuinely has to
    // poll. The cadence tracks whether anything is actually being watched, and
    // backs off while the query is failing.
    refetchInterval: (q) =>
      pollIntervalMs({
        failing: q.state.status === 'error',
        hasActiveWatches: (q.state.data ?? []).some((w) => w.state !== 'EXITED'),
      }),
    refetchIntervalInBackground: false,
  });

  const watches = query.data ?? [];

  /**
   * Insert or replace a watch row from a confirmed server response, newest
   * first — the panel's own ordering.
   */
  const commitWatch = useCallback(
    (row: WatchSession) =>
      writeCache<WatchSession[]>(queryClient, key, (rows = []) => [row, ...rows.filter((w) => w.id !== row.id)]),
    [queryClient, key],
  );

  /**
   * Starting a watch is the one mutation with nothing to be optimistic ABOUT:
   * the row does not exist yet and its id comes from the server. It is still
   * immediate — `onSuccess` writes the returned row straight into the cache
   * instead of waiting for the next poll, which is what "the watch appears in
   * Active Watches the moment you click" actually requires.
   *
   * Both keys are invalidated because a new watch changes what the strategy
   * list shows as being watched.
   */
  const startMutation = useMutation({
    mutationFn: createWatch,
    onSuccess: (created) => commitWatch(created),
    onSettled: () => invalidateWatchSurfaces(queryClient, userId),
  });

  const markEnteredMutation = useMutation({
    mutationFn: ({ watchId, input }: { watchId: string; input: OpenPositionInput }) => openPosition(watchId, input),
    // The user has told us their own numbers, so IN_TRADE with those levels is
    // exactly what the server is about to store — worth showing now.
    onMutate: ({ watchId, input }) =>
      optimistic<WatchSession[]>(queryClient, key, (rows = []) =>
        rows.map((w) =>
          w.id === watchId
            ? {
                ...w,
                state: 'IN_TRADE' as const,
                entryPrice: input.entryPrice,
                stopPrice: input.invalidationPrice,
                targetPrice: input.projectedPrice ?? null,
                direction: input.direction,
              }
            : w,
        ),
      ),
    onError: (_err, _vars, rollback) => rollback?.(),
    onSuccess: (updated) => commitWatch(updated),
    onSettled: () => invalidateWatchSurfaces(queryClient, userId),
  });

  const markClosedMutation = useMutation({
    mutationFn: closePosition,
    onMutate: (watchId) =>
      optimistic<WatchSession[]>(queryClient, key, (rows = []) =>
        rows.map((w) => (w.id === watchId ? { ...w, state: 'EXITED' as const } : w)),
      ),
    onError: (_err, _vars, rollback) => rollback?.(),
    onSuccess: (updated) => commitWatch(updated),
    onSettled: () => invalidateWatchSurfaces(queryClient, userId),
  });

  const refresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const start = useCallback((input: CreateWatchInput) => startMutation.mutateAsync(input), [startMutation]);

  const markEntered = useCallback(
    (watchId: string, input: OpenPositionInput) => markEnteredMutation.mutateAsync({ watchId, input }),
    [markEnteredMutation],
  );

  const markClosed = useCallback((watchId: string) => markClosedMutation.mutateAsync(watchId), [markClosedMutation]);

  const split = splitFault(query.error, query.failureReason, watches.length > 0);

  return {
    watches,
    loading: query.isPending && enabled,
    fault: split.terminal,
    reconnecting: split.transient,
    refresh,
    start,
    markEntered,
    markClosed,
  };
}

// --- shared helpers ----------------------------------------------------------

/**
 * Write `next` into the cache now and hand back the undo.
 *
 * AWAITS the cancellation of any in-flight refetch for the key before writing,
 * and the await is the point. A poll that left the server BEFORE the mutation
 * is carrying pre-mutation state; if it lands after the optimistic write it
 * overwrites it, and the user watches the change they just made silently
 * revert a second later. That is the same hazard the previous implementation
 * guarded with a hand-rolled generation counter.
 *
 * The returned rollback is what React Query hands back as `context` to
 * `onError`, so a server refusal restores exactly what was on screen before.
 */
async function optimistic<T>(
  queryClient: QueryClient,
  key: readonly unknown[],
  next: (previous: T | undefined) => T,
): Promise<() => void> {
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<T>(key);
  queryClient.setQueryData<T>(key, next(previous));
  return () => queryClient.setQueryData<T>(key, previous);
}

/**
 * Write a server response into the cache without cancelling anything — the
 * `onSuccess` counterpart. Used so a confirmed row is on screen on the next
 * frame instead of on the next poll.
 */
function writeCache<T>(queryClient: QueryClient, key: readonly unknown[], next: (previous: T | undefined) => T): void {
  queryClient.setQueryData<T>(key, next(queryClient.getQueryData<T>(key)));
}

/**
 * A watch mutation changes what BOTH panels show, so both keys are refreshed —
 * the strategy list renders per-strategy watch counts off the watch data.
 */
function invalidateWatchSurfaces(queryClient: QueryClient, userId: string | null): void {
  void queryClient.invalidateQueries({ queryKey: sentinelKeys.watches(userId) });
  void queryClient.invalidateQueries({ queryKey: sentinelKeys.strategies(userId) });
}
