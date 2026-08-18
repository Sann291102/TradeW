'use client';

import { useEffect, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { fetchDhanOptionCandles } from '../dhanLiveFeed';

export type OptionCandlesStatus = 'loading' | 'live' | 'unavailable';

/**
 * Why this contract has no series — the same split as `useCandles`, because the
 * two messages are not interchangeable: "this strike has never traded" is a
 * fact about the contract, "the data API declined" is a fault in our plumbing.
 */
export type OptionCandlesUnavailableReason = 'api-unreachable' | 'no-history';

/**
 * REAL OHLC history for one option contract, from Dhan (via the bridge's
 * `/candles/option` route).
 *
 * The contract chart previously drew a Black-Scholes repricing of the
 * UNDERLYING's candles. That was never this contract's traded history: its
 * level depended on a guessed implied vol, and once the series' scale anchor
 * drifted away from the live premium the final bar jumped, drawing a vertical
 * cliff. Genuine per-contract candles remove all of that.
 *
 * Status is 'unavailable' (never fabricated bars) when Dhan has no history for
 * the contract — an illiquid strike, a contract listed today, or the historical
 * API declining — so the caller can fall back explicitly and label it.
 */
export function useOptionCandles(
  underlyingSymbol: string | undefined,
  expiryIso: string | undefined,
  strike: number | undefined,
  optionType: 'CE' | 'PE' | undefined,
  interval: CandleInterval,
  days: number,
): { candles: Candle[] | null; status: OptionCandlesStatus; reason: OptionCandlesUnavailableReason | null } {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [status, setStatus] = useState<OptionCandlesStatus>('loading');
  const [reason, setReason] = useState<OptionCandlesUnavailableReason | null>(null);

  useEffect(() => {
    if (!underlyingSymbol || !expiryIso || strike == null || !optionType) {
      setCandles(null);
      setStatus('unavailable');
      setReason('no-history');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setReason(null);
    // The previous CONTRACT's bars are not this contract's bars. Cleared before
    // the fetch so a strike or expiry change can never leave the old series
    // available to draw — the premium scale of two adjacent strikes is close
    // enough that a stale series looks entirely plausible on screen.
    setCandles(null);

    fetchDhanOptionCandles(underlyingSymbol, expiryIso, strike, optionType, interval, days)
      .then((raw) => {
        if (cancelled) return;
        if (!raw.length) {
          setCandles(null);
          setStatus('unavailable');
          setReason('no-history');
          return;
        }
        setCandles(raw.map((c) => ({ ...c, timestamp: new Date(c.timestamp) })));
        setStatus('live');
        setReason(null);
      })
      .catch(() => {
        if (!cancelled) {
          setCandles(null);
          setStatus('unavailable');
          setReason('api-unreachable');
        }
      });

    return () => {
      cancelled = true;
    };
    // Deliberately NOT keyed on the live price: history reloads only when the
    // contract or timeframe changes. The live price moves the last bar in the
    // chart itself (TradeChart's `liveLast`), which preserves zoom/pan.
  }, [underlyingSymbol, expiryIso, strike, optionType, interval, days]);

  return { candles, status, reason };
}
