'use client';

import { useEffect, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { fetchDhanCandles } from '../dhanLiveFeed';

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
 */
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

    async function load() {
      try {
        const real = await fetchDhanCandles(symbol, interval, days);
        if (cancelled) return;
        if (real.length > 0) {
          setCandles(real.map((c) => ({ ...c, timestamp: new Date(c.timestamp) })));
          setStatus('live');
          setReason(null);
          return;
        }
        // Bridge answered; Dhan simply has no bars for this symbol/interval.
        setCandles(null);
        setStatus('unavailable');
        setReason('no-history');
      } catch {
        // fetch threw — the bridge process is not running or not reachable.
        if (cancelled) return;
        setCandles(null);
        setStatus('unavailable');
        setReason('api-unreachable');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, days]);

  return { candles, status, reason };
}
