'use client';

import { useEffect, useState } from 'react';
import { fetchDhanOptionChain } from '../dhanLiveFeed';

/** The real, live values for ONE option leg (a single strike + CE/PE), taken
 *  straight from Dhan's option chain — the same numbers the Option Chain table
 *  renders. */
export interface OptionQuote {
  strike: number;
  optionType: 'CE' | 'PE';
  ltp: number;
  previousClose: number;
  changePct: number;
  iv: number;
  oi: number;
  volume: number;
  bid: number;
  ask: number;
  /** Underlying spot from the same chain response, so the caller never mixes a
   *  chain LTP with a spot from a different source/instant. */
  spot: number | null;
}

export type OptionQuoteStatus = 'loading' | 'live' | 'unavailable';

/**
 * Matches the Option Chain table's own refresh cadence (CHAIN_REFRESH_MS), so
 * the chart and the chain never drift apart on screen. Dhan's option-chain REST
 * endpoint is rate-limited to ~1 call / 3s and that is the floor; the bridge
 * serializes every call through a gapped FIFO queue behind a short response
 * cache, which collapses this component's polls and the chain table's onto the
 * same upstream call rather than doubling them.
 */
const REFRESH_MS = 3_000;

/** Strikes come back as numbers from Dhan; compare with a small epsilon rather
 *  than `===` so a 23800 vs 23800.0 style mismatch can't silently miss. */
const STRIKE_EPSILON = 0.001;

/**
 * The REAL live quote for one option contract.
 *
 * This exists because the contract chart used to display a Black-Scholes
 * *theoretical* premium derived from the underlying, which does not match the
 * price the Option Chain (and the broker) actually shows for that strike — e.g.
 * NIFTY 23800 CE quoted at 160.75 in the chain while the chart showed ~220.
 * Every consumer that displays an option's price must source it from here so
 * one strike never shows two different numbers in the same app.
 *
 * Returns status 'unavailable' (not a fabricated number) when there is no live
 * chain for this underlying/expiry — the caller decides what to fall back to
 * and must label it as derived.
 */
/**
 * Shared in-flight chain fetches, keyed by `symbol|expiry`. The chart, the
 * chain table and the order ticket all want the same underlying+expiry at the
 * same moment; without this they would each issue their own request and triple
 * the load on a rate-limited upstream for identical data.
 */
const inFlightChain = new Map<string, { at: number; promise: Promise<Awaited<ReturnType<typeof fetchDhanOptionChain>>> }>();
const CHAIN_DEDUPE_MS = 1_000;

function loadChainShared(symbol: string, expiryIso: string) {
  const key = `${symbol}|${expiryIso}`;
  const existing = inFlightChain.get(key);
  if (existing && Date.now() - existing.at < CHAIN_DEDUPE_MS) return existing.promise;
  const promise = fetchDhanOptionChain(symbol, expiryIso).finally(() => {
    // Keep the entry only for the dedupe window, never as a long-lived cache —
    // staleness is the bridge's job to manage, not this hook's.
    setTimeout(() => inFlightChain.delete(key), CHAIN_DEDUPE_MS);
  });
  inFlightChain.set(key, { at: Date.now(), promise });
  return promise;
}

export function useOptionQuote(
  underlyingSymbol: string | undefined,
  /** Real ISO `YYYY-MM-DD` expiry. Without it there is no chain to query, so
   *  the hook reports 'unavailable' rather than guessing an expiry. */
  expiryIso: string | undefined,
  strike: number | undefined,
  optionType: 'CE' | 'PE' | undefined,
): { quote: OptionQuote | null; status: OptionQuoteStatus } {
  const [quote, setQuote] = useState<OptionQuote | null>(null);
  const [status, setStatus] = useState<OptionQuoteStatus>('loading');

  useEffect(() => {
    if (!underlyingSymbol || !expiryIso || strike == null || !optionType) {
      setQuote(null);
      setStatus('unavailable');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    /**
     * Drop the previous contract's quote before loading this one's.
     *
     * Distinct from the `!leg` branch below, which deliberately KEEPS the last
     * value when a row momentarily vanishes from the chain for the SAME
     * contract. Here the contract itself changed, and holding the old number
     * leaks one strike's price into another's panel: `SentinelLiveCharts` feeds
     * this LTP to `sanitizeOptionCandles`, which rescales the whole series
     * against it, so a stale quote does not merely mislabel the last price — it
     * silently re-prices every bar of the new contract's chart.
     */
    setQuote(null);

    const load = async () => {
      const chain = await loadChainShared(underlyingSymbol, expiryIso);
      if (cancelled) return;
      const row = chain?.strikes.find((s) => Math.abs(s.strike - strike) < STRIKE_EPSILON);
      const leg = optionType === 'CE' ? row?.ce : row?.pe;
      if (!leg) {
        // Keep whatever we last had rather than blanking the price mid-session;
        // status tells the caller the number is no longer confirmed live.
        setStatus('unavailable');
        return;
      }
      setQuote({
        strike: row!.strike,
        optionType,
        ltp: leg.ltp,
        previousClose: leg.previousClose,
        changePct: leg.previousClose ? ((leg.ltp - leg.previousClose) / leg.previousClose) * 100 : 0,
        iv: leg.iv,
        oi: leg.oi,
        volume: leg.volume,
        bid: leg.bid,
        ask: leg.ask,
        spot: chain?.spot ?? null,
      });
      setStatus('live');
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlyingSymbol, expiryIso, strike, optionType]);

  return { quote, status };
}
