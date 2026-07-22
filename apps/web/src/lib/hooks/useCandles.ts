'use client';

import { useEffect, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { mockMarketDataProvider } from '../mock/candles';
import { fetchDhanCandles } from '../dhanLiveFeed';

export type CandlesStatus = 'loading' | 'live' | 'preview';

/**
 * Loads OHLCV candles for a symbol/interval.
 *
 * Prefers REAL history from the Dhan bridge's /candles route (which proxies
 * Dhan's Historical Data API) — that's genuine OHLC for the TradingView
 * (lightweight-charts) chart, status 'live'. Falls back to the simulated
 * generator (rescaled to `anchorPrice` when given) for symbols the bridge
 * doesn't cover, or if the bridge/Data-API call fails — status 'preview'.
 */
export function useCandles(
  symbol: string,
  interval: CandleInterval,
  days = 5,
  /** Real live LTP (Dhan bridge) — used only for the simulated fallback,
   *  which rescales its series to end on it. Ignored when real candles load. */
  anchorPrice?: number,
): { candles: Candle[] | null; status: CandlesStatus } {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [status, setStatus] = useState<CandlesStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    async function load() {
      try {
        const real = await fetchDhanCandles(symbol, interval, days);
        if (cancelled) return;
        if (real.length > 0) {
          setCandles(real.map((c) => ({ ...c, timestamp: new Date(c.timestamp) })));
          setStatus('live');
          return;
        }
      } catch {
        // fall through to the simulated generator below
      }
      const mock = await mockMarketDataProvider.getCandles(symbol, interval, from, to, anchorPrice);
      if (cancelled) return;
      setCandles(mock);
      setStatus('preview');
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, days, anchorPrice]);

  return { candles, status };
}
