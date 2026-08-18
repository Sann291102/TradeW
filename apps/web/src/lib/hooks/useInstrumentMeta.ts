'use client';

import { useEffect, useState } from 'react';

const DHAN_LIVE_URL = process.env.NEXT_PUBLIC_DHAN_LIVE_URL || '/feed';

export interface InstrumentMeta {
  symbol: string;
  displayName: string;
  exchange: string;
  exchangeSegment: string;
  instrumentType: 'INDEX' | 'EQUITY' | 'ETF' | 'COMMODITY_FUT';
  lotSize: number;
  /** Lot size for this underlying's option/future contracts (NIFTY 65,
   *  SENSEX 20, BAJAJ-AUTO 75); null when it has no derivatives market. */
  derivativeLotSize: number | null;
  tickSize: number;
}

/** Module-level cache — lot/tick sizes are exchange-defined and effectively
 *  static within a session, so each symbol is fetched at most once. */
const cache = new Map<string, InstrumentMeta | null>();
const inFlight = new Map<string, Promise<InstrumentMeta | null>>();

function load(symbol: string): Promise<InstrumentMeta | null> {
  if (cache.has(symbol)) return Promise.resolve(cache.get(symbol)!);
  let promise = inFlight.get(symbol);
  if (!promise) {
    promise = fetch(`${DHAN_LIVE_URL}/instrument?symbol=${encodeURIComponent(symbol)}`)
      .then((res) => (res.ok ? res.json() : { instrument: null }))
      .then((data: { instrument: InstrumentMeta | null }) => {
        cache.set(symbol, data.instrument);
        return data.instrument;
      })
      .catch((err) => {
        // Never cache a failure — a transient bridge outage shouldn't
        // permanently pin this symbol's lot size to "unknown".
        console.error(`useInstrumentMeta(${symbol}): bridge unreachable`, err);
        return null;
      })
      .finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, promise);
  }
  return promise;
}

/**
 * Exchange-defined contract metadata (lot size, tick size) for a symbol,
 * from the live Dhan scrip master via the bridge's `/instrument` route.
 *
 * Lot size is market-dependent and must never be hardcoded: NIFTY options
 * trade in 65s, SENSEX in 20s, BAJAJ-AUTO in 75s, ADANIPOWER in 3550s, and
 * cash equity in 1s. The order ticket validates quantity against whichever
 * applies to what's actually being traded.
 */
export function useInstrumentMeta(symbol: string | undefined): InstrumentMeta | null {
  // Always start at null, never from `cache`. The cache is empty during SSR but
  // often already warm on the client (a previous page populated it), so seeding
  // initial state from it made the first client render disagree with the server
  // HTML — React's "Expected server HTML to contain a matching <div>" hydration
  // error. The effect below re-reads the cache synchronously on mount, so a
  // warm value still appears immediately; it just no longer happens during the
  // hydration pass.
  const [meta, setMeta] = useState<InstrumentMeta | null>(null);

  useEffect(() => {
    if (!symbol) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    setMeta(cache.get(symbol) ?? null);
    load(symbol).then((result) => {
      if (!cancelled) setMeta(result);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return meta;
}
