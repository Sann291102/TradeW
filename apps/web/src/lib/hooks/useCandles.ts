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
 *
 * That generator survived here (and in the bridge) long after the rule was
 * written, reporting status 'live' over a seeded random walk, which is how a
 * Dhan rate-limit mid-session turned into charts that looked fine and were
 * fabricated. Removed 2026-08-10 — both halves of it.
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
      if (!symbol) {
        setCandles(null);
        setStatus('unavailable');
        setReason('no-history');
        return;
      }
      try {
        const real = await fetchDhanCandles(symbol, interval, days);
        if (cancelled) return;
        if (real.length === 0) {
          // The bridge answered and Dhan simply has no bars for this contract.
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
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, days]);

  return { candles, status, reason };
}
