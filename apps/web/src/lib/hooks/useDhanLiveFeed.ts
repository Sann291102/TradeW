'use client';

import { useEffect, useState } from 'react';
import { fetchDhanQuotes, type DhanLiveQuote, type DhanLiveSnapshot } from '../dhanLiveFeed';

export type DhanFeedStatus = 'loading' | 'live' | 'closed' | 'unreachable';

const DHAN_LIVE_URL = process.env.NEXT_PUBLIC_DHAN_LIVE_URL || 'http://localhost:4600';
const POLL_MS = 5000;
const EMPTY_SNAPSHOT: DhanLiveSnapshot = { marketOpen: false, indices: [], stocks: [], commodities: [] };

type State = { snapshot: DhanLiveSnapshot | null; status: DhanFeedStatus };
type Listener = (state: State) => void;

/**
 * Module-level singleton connection to the Dhan live-feed bridge.
 *
 * Every dashboard widget (Ticker, IndexOverview, TopBar, MarketMovers,
 * TrendingStocks, CommodityMarkets, ChartPanel — 7+ call sites) uses
 * `useDhanLiveFeed`. Each one opening its own EventSource blew past the
 * browser's ~6-connections-per-origin limit for a single host (SSE
 * connections are long-lived, so they never freed a slot), which starved
 * every other request to localhost:4600 — including plain fetches. One
 * shared connection, fanned out to all hook instances, fixes that.
 */
let listeners = new Set<Listener>();
let state: State = { snapshot: null, status: 'loading' };
let source: EventSource | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function setState(next: State) {
  state = next;
  listeners.forEach((l) => l(state));
}

function apply(data: DhanLiveSnapshot) {
  if (data.indices.length === 0 && data.stocks.length === 0 && data.commodities.length === 0) {
    setState({ snapshot: state.snapshot, status: 'unreachable' });
    return;
  }
  setState({ snapshot: data, status: data.marketOpen ? 'live' : 'closed' });
}

async function poll() {
  try {
    apply(await fetchDhanQuotes());
  } catch {
    setState({ snapshot: state.snapshot, status: 'unreachable' });
  } finally {
    pollTimer = setTimeout(poll, POLL_MS);
  }
}

function ensureStarted() {
  if (started) return;
  started = true;

  if (typeof EventSource !== 'undefined') {
    try {
      source = new EventSource(`${DHAN_LIVE_URL}/stream`);
      source.onmessage = (event) => apply(JSON.parse(event.data) as DhanLiveSnapshot);
      source.onerror = () => setState({ snapshot: state.snapshot, status: 'unreachable' });
      return;
    } catch {
      // fall through to polling
    }
  }
  void poll();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  ensureStarted();
  listener(state);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      started = false;
      state = { snapshot: null, status: 'loading' };
    }
  };
}

/**
 * Subscribes to the shared Dhan live-feed connection (see singleton above).
 * Reports 'live' only when the exchange session is open and ticks are real;
 * 'closed' when the bridge is reachable and returning genuine last-session
 * data but the market itself is shut; 'unreachable' when the bridge can't be
 * reached at all, so the UI can fall back to the mock preview.
 *
 * `quotes` is kept as the indices array (its original shape) so existing
 * callers (Ticker, IndexOverview, TopBar, ChartPanel) don't need to change;
 * `stocks`/`commodities` are the newer groups (Market Movers, Trending
 * Stocks, Commodities widget).
 */
export function useDhanLiveFeed(): {
  quotes: DhanLiveQuote[] | null;
  stocks: DhanLiveQuote[] | null;
  commodities: DhanLiveQuote[] | null;
  status: DhanFeedStatus;
} {
  const [local, setLocal] = useState<State>(state);

  useEffect(() => subscribe(setLocal), []);

  const s = local.snapshot ?? EMPTY_SNAPSHOT;
  return {
    quotes: local.snapshot ? s.indices : null,
    stocks: local.snapshot ? s.stocks : null,
    commodities: local.snapshot ? s.commodities : null,
    status: local.status,
  };
}
