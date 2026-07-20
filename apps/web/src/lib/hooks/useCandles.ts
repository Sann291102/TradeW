'use client';

import { useEffect, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { mockMarketDataProvider } from '../mock/candles';

export type CandlesStatus = 'loading' | 'live' | 'preview';

/**
 * Loads OHLCV candles for a symbol/interval. Mirrors `useLiveQuotes`'s
 * loading/live/preview shape so the two hooks read consistently — status
 * stays 'preview' until a real candle endpoint exists to promote it to
 * 'live' (see mock/candles.ts's doc comment).
 */
export function useCandles(
  symbol: string,
  interval: CandleInterval,
  days = 5,
): { candles: Candle[] | null; status: CandlesStatus } {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [status, setStatus] = useState<CandlesStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    mockMarketDataProvider.getCandles(symbol, interval, from, to).then((data) => {
      if (cancelled) return;
      setCandles(data);
      setStatus('preview');
    });

    return () => {
      cancelled = true;
    };
  }, [symbol, interval, days]);

  return { candles, status };
}
