'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  subscribeToGraph,
  systemGraph,
  type GraphEvent,
  type GraphFilter,
  type GraphMeta,
  type GraphSlice,
} from './graph';

/**
 * The shared state behind both graph pages.
 *
 * ## Why one hook and not two pages of duplicated fetching
 *
 * The Knowledge Graph and the Neural Network are two projections of one
 * dataset. If each page owned its own loading, filtering and expansion logic,
 * "the same node" would mean two slightly different things within a week —
 * one page would cap at a different limit, or apply a filter the other did
 * not, and the two pictures would quietly stop agreeing. They share this.
 *
 * ## What "progressive" means here concretely
 *
 * The page never loads the whole graph. It loads:
 *
 *   base       — a filtered, budgeted slice (the server caps it at 900)
 *   expansions — the neighbourhoods of nodes the operator explicitly opened
 *
 * and merges them. On refresh both are re-fetched, so an expansion survives
 * a snapshot rebuild and keeps updating rather than freezing at the values it
 * had when it was opened. Collapsing an expansion removes only what nothing
 * else is holding on to.
 *
 * ## Live without re-fetching
 *
 * Events from the SSE stream drive the canvas's pulses directly and do NOT
 * trigger a reload — a busy API would otherwise re-fetch the graph hundreds of
 * times a minute. The periodic refresh is what moves the numbers; the stream
 * is what makes the picture move. A structural event (`graph.rebuilt`) is the
 * one exception, and it schedules the next refresh immediately.
 */

/** How often the loaded slice is re-fetched. Matches the server's own snapshot
 *  refresh, so a poll never lands on the same snapshot twice for no reason. */
const REFRESH_MS = 30_000;

/** Ceiling on retained events. Enough for a live feed panel; not a session log. */
const MAX_EVENTS = 60;

export interface SystemGraphState {
  meta: GraphMeta | null;
  slice: GraphSlice | null;
  events: GraphEvent[];
  filter: GraphFilter;
  setFilter: (filter: GraphFilter) => void;
  selected: string[];
  setSelected: (ids: string[]) => void;
  expanded: string[];
  expand: (id: string) => void;
  collapse: (id: string) => void;
  collapseAll: () => void;
  live: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  lastLoadedAt: number | null;
}

export function useSystemGraph(initialFilter: GraphFilter): SystemGraphState {
  const [meta, setMeta] = useState<GraphMeta | null>(null);
  const [base, setBase] = useState<GraphSlice | null>(null);
  const [expansions, setExpansions] = useState<Record<string, GraphSlice>>({});
  const [filter, setFilter] = useState<GraphFilter>(initialFilter);
  const [selected, setSelected] = useState<string[]>([]);
  const [events, setEvents] = useState<GraphEvent[]>([]);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const expandedRef = useRef<string[]>([]);
  expandedRef.current = Object.keys(expansions);

  // The filter is an object; using it directly as an effect dependency would
  // re-fetch on every render. Serialising it makes the dependency the VALUE.
  const filterKey = JSON.stringify(filter);

  // ---- meta ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void systemGraph
      .meta()
      .then((row) => {
        if (!cancelled) setMeta(row);
      })
      .catch(() => {
        /* the legend degrading is not worth an error banner; the graph load
           below reports a real outage on its own */
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // ---- the base slice -----------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void systemGraph
      .nodes(JSON.parse(filterKey) as GraphFilter)
      .then((slice) => {
        if (cancelled) return;
        setBase(slice);
        setError(null);
        setLastLoadedAt(Date.now());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the system graph.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filterKey, tick]);

  // ---- expansions ---------------------------------------------------------

  // Re-fetched on every tick alongside the base, so an opened neighbourhood
  // keeps updating rather than freezing at the values it had when it opened.
  useEffect(() => {
    const ids = expandedRef.current;
    if (ids.length === 0) return;
    let cancelled = false;
    for (const id of ids) {
      void systemGraph
        .neighborhood([id], 1, { ...(JSON.parse(filterKey) as GraphFilter), limit: 120 })
        .then((slice) => {
          if (cancelled) return;
          setExpansions((current) => (current[id] ? { ...current, [id]: slice } : current));
        })
        .catch(() => {
          /* one stale expansion is not worth failing the page */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [tick, filterKey]);

  const expand = useCallback(
    (id: string) => {
      setExpansions((current) => (current[id] ? current : { ...current, [id]: emptySlice() }));
      void systemGraph
        .neighborhood([id], 1, { ...filter, limit: 120 })
        .then((slice) => setExpansions((current) => ({ ...current, [id]: slice })))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not expand that node.'));
    },
    [filter],
  );

  const collapse = useCallback((id: string) => {
    setExpansions((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpansions({}), []);

  // ---- the live stream ----------------------------------------------------

  useEffect(() => {
    // Seed from the replay buffer so a console opening into a quiet minute has
    // something real to show rather than an empty feed.
    void systemGraph
      .events(25)
      .then((rows) => setEvents((current) => (current.length ? current : rows)))
      .catch(() => undefined);

    const unsubscribe = subscribeToGraph(
      (event) => {
        setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
        // A structural change means the SHAPE moved, not just the numbers, so
        // pull the next snapshot now instead of waiting out the poll.
        if (event.kind === 'graph.rebuilt') setTick((value) => value + 1);
      },
      { onOpen: () => setLive(true), onError: () => setLive(false) },
    );
    return unsubscribe;
  }, []);

  // ---- periodic refresh ---------------------------------------------------

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  // ---- merge --------------------------------------------------------------

  /**
   * Merge the base slice with every open expansion.
   *
   * De-duplicated by id, so a node reached from two expansions appears once.
   * `truncated` is the union: a node can have un-loaded neighbours according
   * to one slice and not another, and the honest answer is "there is more".
   */
  const slice = useMemo<GraphSlice | null>(() => {
    if (!base) return null;
    const parts = [base, ...Object.values(expansions)];
    const nodes = new Map<string, GraphSlice['nodes'][number]>();
    const edges = new Map<string, GraphSlice['edges'][number]>();
    const truncated = new Set<string>();
    for (const part of parts) {
      for (const node of part.nodes) nodes.set(node.id, node);
      for (const edge of part.edges) edges.set(edge.id, edge);
      for (const id of part.truncated) truncated.add(id);
    }
    // An expansion loads a node's neighbours, so it is no longer truncated
    // through THAT node even though the base slice said it was.
    for (const id of Object.keys(expansions)) {
      if (expansions[id].nodes.length > 0) truncated.delete(id);
    }
    // Edges are only kept when both endpoints are present. An expansion's
    // edges can name nodes a filter removed from the base.
    const present = new Set(nodes.keys());
    for (const [id, edge] of Array.from(edges.entries())) {
      if (!present.has(edge.source) || !present.has(edge.target)) edges.delete(id);
    }
    return {
      ...base,
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      truncated: Array.from(truncated),
    };
  }, [base, expansions]);

  return {
    meta,
    slice,
    events,
    filter,
    setFilter,
    selected,
    setSelected,
    expanded: Object.keys(expansions),
    expand,
    collapse,
    collapseAll,
    live,
    paused,
    setPaused,
    loading,
    error,
    refresh,
    lastLoadedAt,
  };
}

function emptySlice(): GraphSlice {
  return {
    nodes: [],
    edges: [],
    clusters: [],
    totals: { nodes: 0, edges: 0, clusters: 0 },
    truncated: [],
    builtAt: Date.now(),
    cached: false,
    degraded: [],
  };
}
