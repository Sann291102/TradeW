'use client';

import { useEffect, useState } from 'react';
import { fetchDhanHasOptionChain } from '../dhanLiveFeed';

/**
 * Whether `symbol` has a live options market — determined dynamically from
 * Dhan's own Option Chain API (bridge's `/optionchain/expirylist` route),
 * the same signal OptionChainTab itself uses. No hardcoded stock/commodity
 * list anywhere: a non-empty expiry list means options exist, an empty list
 * (or an unrecognized symbol) means they don't, and that answer comes
 * straight from the exchange's real derivatives data, not a maintained set.
 *
 * Module-level cache + in-flight de-dup so the same symbol is only ever
 * checked once per session — confirmed answers (true/false) are cached
 * indefinitely (a stock's option-chain eligibility doesn't change
 * intraday); an undetermined result (bridge unreachable, network error) is
 * NOT cached, so it's retried on the next mount instead of permanently
 * hiding a tab that was only unreachable, not actually optionless.
 *
 * Returns `false` while unresolved — per the "hide until determined" rule,
 * callers should treat unresolved the same as "no chain" rather than
 * flashing the tab and then yanking it away.
 */
const cache = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean | null>>();

function resolve(symbol: string): Promise<boolean | null> {
  const cached = cache.get(symbol);
  if (cached != null) return Promise.resolve(cached);

  let promise = inFlight.get(symbol);
  if (!promise) {
    promise = fetchDhanHasOptionChain(symbol).finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, promise);
  }
  return promise.then((result) => {
    if (result != null) cache.set(symbol, result);
    return result;
  });
}

export function useHasOptionChain(symbol: string): boolean {
  const [hasChain, setHasChain] = useState(() => cache.get(symbol) ?? false);

  useEffect(() => {
    let cancelled = false;
    setHasChain(cache.get(symbol) ?? false);
    resolve(symbol).then((result) => {
      if (!cancelled && result != null) setHasChain(result);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return hasChain;
}
