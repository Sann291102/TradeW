'use client';

import { useEffect, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { fetchDhanCandles } from '../dhanLiveFeed';

export type CandlesStatus = 'loading' | 'live' | 'unavailable' | 'cached';

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
 *
 * Now with fallback support for previous day's cached data when API is unreachable.
 */

const CACHE_KEY_PREFIX = 'tradew_candles_';
// 72h keeps the last market session usable across weekends/holidays.
const CACHE_EXPIRY_HOURS = 72;

interface CachedCandlesPayload {
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  timestamp: number;
}

function getCacheKey(symbol: string, interval: CandleInterval): string {
  return `${CACHE_KEY_PREFIX}${symbol}_${interval}`;
}

function parseCachedCandles(raw: string): Candle[] | null {
  const parsed = JSON.parse(raw) as CachedCandlesPayload;
  if (!parsed || !Array.isArray(parsed.candles) || typeof parsed.timestamp !== 'number') return null;
  const ageHours = (Date.now() - parsed.timestamp) / (1000 * 60 * 60);
  if (ageHours >= CACHE_EXPIRY_HOURS) return null;
  return parsed.candles.map((c) => ({ ...c, timestamp: new Date(c.timestamp) }));
}

function getCachedCandles(symbol: string, interval: CandleInterval): Candle[] | null {
  if (typeof window === 'undefined') return null;

  const exactKey = getCacheKey(symbol, interval);
  try {
    const exact = localStorage.getItem(exactKey);
    if (exact) {
      const parsed = parseCachedCandles(exact);
      if (parsed && parsed.length > 0) return parsed;
    }

    // Fallback: any recent cached interval for this symbol (for example 5m
    // exists but 15m was never loaded on this device yet).
    let best: { candles: Candle[]; timestamp: number } | null = null;
    const symbolPrefix = `${CACHE_KEY_PREFIX}${symbol}_`;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(symbolPrefix) || key === exactKey) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as CachedCandlesPayload;
      if (!parsed || !Array.isArray(parsed.candles) || typeof parsed.timestamp !== 'number') continue;
      const ageHours = (Date.now() - parsed.timestamp) / (1000 * 60 * 60);
      if (ageHours >= CACHE_EXPIRY_HOURS || parsed.candles.length === 0) continue;
      if (!best || parsed.timestamp > best.timestamp) {
        best = {
          candles: parsed.candles.map((c) => ({ ...c, timestamp: new Date(c.timestamp) })),
          timestamp: parsed.timestamp,
        };
      }
    }
    return best?.candles ?? null;
  } catch (err) {
    console.warn(`useCandles: failed to read cache for ${symbol} ${interval}`, err);
    return null;
  }
}

function setCachedCandles(symbol: string, interval: CandleInterval, candles: Candle[]): void {
  if (typeof window === 'undefined') return;
  try {
    const key = getCacheKey(symbol, interval);
    const serialized = candles.map((c) => ({
      ...c,
      timestamp: c.timestamp.toISOString(),
    }));
    localStorage.setItem(
      key,
      JSON.stringify({
        candles: serialized,
        timestamp: Date.now(),
      })
    );
  } catch (err) {
    console.warn(`useCandles: failed to persist cache for ${symbol} ${interval}`, err);
  }
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
        const candlesWithDate = real.map((c) => ({ ...c, timestamp: new Date(c.timestamp) }));
        setCandles(candlesWithDate);
        // Cache the successful response
        setCachedCandles(symbol, interval, candlesWithDate);
        setStatus('live');
        setReason(null);
      } catch {
        // The bridge or Dhan itself faulted — an outage, a rate limit, an
        // expired token. Try to use cached data as fallback.
        if (cancelled) return;
        
        const cachedData = getCachedCandles(symbol, interval);
        if (cachedData && cachedData.length > 0) {
          // Use cached data when API is unreachable
          setCandles(cachedData);
          setStatus('cached');
          setReason(null);
        } else {
          // No cache available, show error
          setCandles(null);
          setStatus('unavailable');
          setReason('api-unreachable');
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, days]);

  return { candles, status, reason };
}
