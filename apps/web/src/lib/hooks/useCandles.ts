'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { fetchDhanCandles } from '../dhanLiveFeed';
import { fetchCryptoCandles } from '../externalMarkets';
import { instrumentBySymbol } from '../instruments/catalog';
import { useDhanLiveFeed } from './useDhanLiveFeed';
import { mergeLiveCandle } from './liveCandle';

/**
 * How often the closed-bar history is refetched while a chart is mounted.
 *
 * The live tick keeps the FORMING bar current between these, so this is only
 * about a bucket closing and the next one being confirmed by the exchange —
 * a minute of lag on a settled bar is invisible, whereas polling `/candles`
 * aggressively is not: Dhan's historical API is rate-limited, and exhausting it
 * makes the endpoint return empty, which this hook can only honestly report as
 * "no history".
 */
const REFRESH_MS = 60_000;

export type CandlesStatus = 'loading' | 'live' | 'unavailable';

/**
 * Why no series is available. The UI states this instead of drawing something.
 *  - 'api-unreachable' — the Dhan bridge could not be reached at all.
 *  - 'no-history'      — the bridge answered, Dhan has no bars for this symbol.
 */
export type CandlesUnavailableReason = 'api-unreachable' | 'no-history';

/**
 * Loads REAL OHLCV candles for a symbol/interval from the Dhan bridge's
 * `/candles` route (which proxies Dhan's Historical Data REST API).
 *
 * There is deliberately NO fallback series. Per the 2026-07-26 no-fabricated-
 * data rule, a chart with no real history renders nothing and says why. The
 * previous behaviour — dropping to a simulated generator rescaled onto the
 * live LTP — made a bridge outage look like a quiet but functioning market,
 * which is the single most expensive kind of wrong a trading screen can be.
 *
 * That generator survived here (and in the bridge) long after the rule was
 * written, reporting status 'live' over a seeded random walk, which is how a
 * Dhan rate-limit mid-session turned into charts that looked fine and were
 * fabricated. Removed 2026-08-10 — both halves of it.
 */
/**
 * Route a bar request to the provider the instrument declares.
 *
 * Only the two sources that can feed the NATIVE chart are here. Twelve Data
 * (FX, US equities) is deliberately absent: its free tier allows 8 requests a
 * minute, which a mounted chart refetching on a 60s timer would spend on a
 * single tab, so those instruments stay `chartSurface: 'embed'` in the catalog
 * until a server-side candle cache exists. An instrument whose `candleSource`
 * this function does not handle gets no bars and the caller says so — it does
 * not silently fall through to Dhan and render another market's history under
 * this symbol's name.
 *
 * Binance's kline ceiling is 1000 bars and it takes a count, not a day range,
 * so `days` is converted using the interval's own bar duration and clamped.
 */
const BARS_PER_DAY: Record<string, number> = {
  // Crypto trades continuously, so a day really is 1440 one-minute bars.
  '1m': 1440,
  '5m': 288,
  '15m': 96,
  '1h': 24,
  '1d': 1,
};

/**
 * A bar as it arrives from a provider, before the timestamp is revived.
 *
 * Dhan sends epoch milliseconds, Binance sends an ISO string over JSON. The
 * single `new Date(c.timestamp)` in the caller normalises both — which is why
 * this type is loose about that one field and exact about the rest.
 */
type WireCandle = Omit<Candle, 'timestamp'> & { timestamp: Date | string | number };

async function loadBars(symbol: string, interval: CandleInterval, days: number): Promise<WireCandle[]> {
  const ref = instrumentBySymbol(symbol);

  if (ref?.candleSource === 'binance') {
    const limit = Math.min(1000, Math.max(1, Math.round((BARS_PER_DAY[interval] ?? 96) * days)));
    return fetchCryptoCandles(symbol, interval, limit);
  }

  // Unknown symbols keep the Dhan path: the catalog does not enumerate every
  // option contract or every listed scrip, and the bridge is the authority on
  // those. A symbol the catalog DOES know with a non-Dhan source never gets
  // here, which is the part that matters.
  if (!ref || ref.candleSource === 'dhan') {
    return fetchDhanCandles(symbol, interval, days);
  }

  return [];
}

export function useCandles(
  symbol: string,
  interval: CandleInterval,
  days = 5,
): { candles: Candle[] | null; status: CandlesStatus; reason: CandlesUnavailableReason | null } {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [status, setStatus] = useState<CandlesStatus>('loading');
  const [reason, setReason] = useState<CandlesUnavailableReason | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setReason(null);
    // Drop the PREVIOUS instrument's bars before fetching the new one's.
    //
    // Without this the hook keeps returning the old symbol's series — merged
    // with the NEW symbol's live tick by `mergeLiveCandle` below — for as long
    // as the fetch is in flight. Callers that gate on `status` never draw it,
    // but the returned value is genuinely two instruments spliced together, and
    // a chart that switches market must not have that array available to
    // render at all. The 60s refresh timer calls `load()` directly and does not
    // clear, so a settled series is never blanked by a routine refetch.
    setCandles(null);

    async function load() {
      if (!symbol) {
        setCandles(null);
        setStatus('unavailable');
        setReason('no-history');
        return;
      }
      try {
        // WHICH BACKEND serves this instrument is a property of the instrument,
        // not of this hook. Before the catalog existed this went straight to
        // Dhan for every symbol, so a crypto pair could only ever come back
        // empty — which the panel then reported, accurately but uselessly, as
        // "Dhan returned no candles for BTCUSDT".
        const real = await loadBars(symbol, interval, days);
        if (cancelled) return;
        if (real.length === 0) {
          // The provider answered and simply has no bars for this contract.
          setCandles(null);
          setStatus('unavailable');
          setReason('no-history');
          return;
        }
        setCandles(real.map((c) => ({ ...c, timestamp: new Date(c.timestamp) })));
        setStatus('live');
        setReason(null);
      } catch {
        // The bridge or Dhan itself faulted — an outage, a rate limit, an
        // expired token. Named as such so the panel doesn't blame the symbol.
        if (cancelled) return;
        setCandles(null);
        setStatus('unavailable');
        setReason('api-unreachable');
      }
    }

    void load();
    // Refetch on a timer so a bar that closes while the chart is open is
    // eventually confirmed by the exchange rather than left as the merged
    // forming bar forever. Paused while the tab is hidden — a background tab
    // spending Dhan's rate limit is how the endpoint starts returning empty.
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, interval, days]);

  /**
   * The live tick, from the same shared feed the price cards read.
   *
   * This is what closes the gap in the bug report: the historical series ends
   * at the last CLOSED bar, so without merging, the chart's right edge sits at
   * yesterday's close while the card beside it shows today's price.
   */
  const { quotes, stocks, etfs, commodities } = useDhanLiveFeed();
  const quote = useMemo(() => {
    if (!symbol) return null;
    return (
      [...(quotes ?? []), ...(stocks ?? []), ...(etfs ?? []), ...(commodities ?? [])].find(
        (q) => q.symbol === symbol,
      ) ?? null
    );
  }, [symbol, quotes, stocks, etfs, commodities]);

  const merged = useMemo(
    () => mergeLiveCandle(candles, quote, interval),
    [candles, quote, interval],
  );

  return { candles: merged, status, reason };
}
