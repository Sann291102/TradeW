'use client';

import { useEffect, useState } from 'react';
import { fetchDhanQuotes, type DhanLiveQuote, type DhanLiveSnapshot } from '../dhanLiveFeed';

export type DhanFeedStatus = 'loading' | 'live' | 'closed' | 'unreachable';

const DHAN_LIVE_URL = process.env.NEXT_PUBLIC_DHAN_LIVE_URL || '/feed';
const POLL_MS = 5000;
/**
 * How long a transient interruption is tolerated before the pill is allowed to
 * fall back to "Status unknown". The bridge streams continuously while the
 * market is open and EventSource auto-reconnects on its own, so a dropped
 * connection almost always recovers within a second — far inside this window.
 * Only a genuine, sustained outage outlasts the grace period.
 */
const GRACE_MS = 20000;
const EMPTY_SNAPSHOT: DhanLiveSnapshot = { marketOpen: false, indices: [], stocks: [], etfs: [], commodities: [] };

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
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function setState(next: State) {
  state = next;
  listeners.forEach((l) => l(state));
}

function clearGrace() {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}

/**
 * A transient failure — an SSE reconnect, a failed poll, or a momentarily
 * empty payload. Don't flip the pill straight to "Status unknown": hold the
 * last known status and only fall back to 'unreachable' if nothing recovers
 * within GRACE_MS. This is what stops the market-status pill flickering
 * live -> unknown -> live every few seconds on an otherwise-healthy feed.
 */
function scheduleUnreachable() {
  if (graceTimer || state.status === 'unreachable') return;
  graceTimer = setTimeout(() => {
    graceTimer = null;
    setState({ snapshot: state.snapshot, status: 'unreachable' });
  }, GRACE_MS);
}

function apply(data: DhanLiveSnapshot) {
  const empty =
    data.indices.length === 0 &&
    data.stocks.length === 0 &&
    data.etfs.length === 0 &&
    data.commodities.length === 0;
  if (empty) {
    scheduleUnreachable();
    return;
  }
  clearGrace();
  setState({ snapshot: data, status: data.marketOpen ? 'live' : 'closed' });
}

async function poll() {
  try {
    apply(await fetchDhanQuotes());
  } catch {
    scheduleUnreachable();
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
      source.onerror = () => scheduleUnreachable();
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
      clearGrace();
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
 * `stocks`/`etfs`/`commodities` are the newer groups (Market Movers,
 * Trending Stocks, Markets page, Commodities widget) — the bridge resolves
 * the full NSE F&O stock universe and every NSE ETF from Dhan's scrip
 * master at boot, not a hand-picked handful.
 */
export function useDhanLiveFeed(): {
  quotes: DhanLiveQuote[] | null;
  stocks: DhanLiveQuote[] | null;
  etfs: DhanLiveQuote[] | null;
  commodities: DhanLiveQuote[] | null;
  status: DhanFeedStatus;
} {
  // Deliberately NOT seeded from the module-level `state` singleton. That
  // singleton is empty during SSR but usually already holds a snapshot on the
  // client (another widget started the feed first), so seeding from it made the
  // first client render disagree with the server HTML — a React hydration
  // mismatch. `subscribe` pushes the current state synchronously on mount, so
  // the real snapshot still lands immediately, just after hydration.
  const [local, setLocal] = useState<State>({ snapshot: null, status: 'loading' });

  useEffect(() => subscribe(setLocal), []);

  const s = local.snapshot ?? EMPTY_SNAPSHOT;
  return {
    quotes: local.snapshot ? s.indices : null,
    stocks: local.snapshot ? s.stocks : null,
    etfs: local.snapshot ? s.etfs : null,
    commodities: local.snapshot ? s.commodities : null,
    status: local.status,
  };
}
