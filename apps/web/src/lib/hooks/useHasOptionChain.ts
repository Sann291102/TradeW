'use client';

import { useEffect, useState } from 'react';
import { fetchDhanHasOptionChain } from '../dhanLiveFeed';

/**
 * Whether `symbol` has a live options market — determined dynamically from
 * Dhan's own Option Chain API (bridge's `/optionchain/expirylist` route),
 * the same signal OptionChainTab itself uses. No hardcoded stock/commodity
 * list anywhere: a non-empty expiry list means options exist and an empty
 * list means they don't, straight from the exchange's real derivatives data.
 *
 * Three states, not two. The old boolean collapsed "confirmed optionless"
 * and "couldn't ask" into `false`, and the caller hid the tab on false — so
 * with the bridge down, NIFTY (the most heavily traded options underlying on
 * the exchange) rendered with no Option Chain tab at all. An outage must
 * never look like an instrument fact. 'unknown' is now its own state and the
 * caller keeps the tab, showing "not connected" inside it.
 *
 * Module-level cache + in-flight de-dup so a symbol is only checked once per
 * session. Confirmed answers are cached indefinitely (option eligibility
 * doesn't change intraday); 'unknown' is never cached, so it retries on the
 * next mount.
 */
export type OptionChainAvailability = 'yes' | 'no' | 'unknown';

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

function toState(value: boolean | null | undefined): OptionChainAvailability {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
}

export function useHasOptionChain(symbol: string): OptionChainAvailability {
  const [state, setState] = useState<OptionChainAvailability>(() => toState(cache.get(symbol)));

  useEffect(() => {
    let cancelled = false;
    setState(toState(cache.get(symbol)));
    void resolve(symbol).then((result) => {
      if (!cancelled) setState(toState(result));
    });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return state;
}
