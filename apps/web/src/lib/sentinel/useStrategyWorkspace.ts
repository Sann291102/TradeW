'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyFault, type SentinelUnavailable } from './faults';
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
 * Two separate hooks rather than one store because the two halves refresh for
 * different reasons: strategies change only when the user changes them, while
 * watch state is advanced server-side by the sweep loop and has to be polled.
 *
 * Both surface failures as a `SentinelUnavailable` rather than a bare boolean,
 * so the panels can say which of "not signed in" / "not entitled" / "API down"
 * actually happened — the same rule the rest of Sentinel follows.
 */

/**
 * How often the watch list is re-read.
 *
 * The engine sweeps on its own schedule and writes state to the database; the
 * browser has no push channel for it (notifications go through the existing
 * 30s `/notifications` poll). 15s is well inside the cadence at which a state
 * change matters to someone sitting in front of the panel, and the request is
 * a single indexed query per user.
 */
const WATCH_POLL_MS = 15_000;

export interface StrategiesResult {
  strategies: UserStrategy[];
  loading: boolean;
  fault: SentinelUnavailable | null;
  refresh: () => Promise<void>;
  save: (input: { name: string; rawInput: string; rules: ParsedStrategy }) => Promise<UserStrategy>;
  setStatus: (id: string, status: StrategyStatus) => Promise<void>;
  archive: (id: string) => Promise<void>;
}

export function useUserStrategies(enabled = true): StrategiesResult {
  const [strategies, setStrategies] = useState<UserStrategy[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [fault, setFault] = useState<SentinelUnavailable | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setStrategies(await listStrategies());
      setFault(null);
    } catch (err) {
      // Keep nothing on failure: a stale list next to a "couldn't load"
      // message reads as if the stale list were current.
      setStrategies([]);
      setFault(classifyFault(err));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Throws on failure so the form can keep the user's draft and say why. */
  const save = useCallback(
    async (input: { name: string; rawInput: string; rules: ParsedStrategy }) => {
      const created = await createStrategy(input);
      // Prepend rather than refetch: the row is authoritative as returned, and
      // the new strategy is visible the instant it is saved.
      setStrategies((prev) => [created, ...prev]);
      setFault(null);
      return created;
    },
    [],
  );

  const setStatus = useCallback(async (id: string, status: StrategyStatus) => {
    const updated = await updateStrategy(id, { status });
    setStrategies((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const archive = useCallback(async (id: string) => {
    const archived = await archiveStrategy(id);
    // Kept in the list with its new status rather than dropped: the picker
    // already hides archived strategies (`selectableStrategies`), and a watch
    // card still needs to resolve this id to a NAME. Dropping the row renamed
    // every existing watch to "Strategy no longer listed".
    setStrategies((prev) => prev.map((s) => (s.id === id ? archived : s)));
  }, []);

  return { strategies, loading, fault, refresh, save, setStatus, archive };
}

export interface WatchesResult {
  watches: WatchSession[];
  loading: boolean;
  fault: SentinelUnavailable | null;
  refresh: () => Promise<void>;
  start: (input: CreateWatchInput) => Promise<WatchSession>;
  markEntered: (watchId: string, input: OpenPositionInput) => Promise<WatchSession>;
  markClosed: (watchId: string) => Promise<WatchSession>;
}

export function useWatchSessions(enabled = true): WatchesResult {
  const [watches, setWatches] = useState<WatchSession[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [fault, setFault] = useState<SentinelUnavailable | null>(null);
  // Guards against a slow in-flight poll landing after a mutation and
  // resurrecting the pre-mutation state for a few seconds.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const mine = ++generation.current;
    try {
      const next = await listWatches();
      if (mine !== generation.current) return;
      setWatches(next);
      setFault(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setWatches([]);
      setFault(classifyFault(err));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || typeof document === 'undefined' || document.hidden) return;
      timer = setInterval(() => void refresh(), WATCH_POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    // A hidden tab is not being read; resume with an immediate refresh so the
    // panel is current the moment it comes back rather than up to 15s stale.
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
  }, [enabled, refresh]);

  const upsert = useCallback((row: WatchSession) => {
    generation.current++;
    setWatches((prev) => {
      const without = prev.filter((w) => w.id !== row.id);
      return [row, ...without];
    });
  }, []);

  const start = useCallback(
    async (input: CreateWatchInput) => {
      const created = await createWatch(input);
      upsert(created);
      setFault(null);
      return created;
    },
    [upsert],
  );

  const markEntered = useCallback(
    async (watchId: string, input: OpenPositionInput) => {
      const updated = await openPosition(watchId, input);
      upsert(updated);
      return updated;
    },
    [upsert],
  );

  const markClosed = useCallback(
    async (watchId: string) => {
      const updated = await closePosition(watchId);
      upsert(updated);
      return updated;
    },
    [upsert],
  );

  return { watches, loading, fault, refresh, start, markEntered, markClosed };
}
