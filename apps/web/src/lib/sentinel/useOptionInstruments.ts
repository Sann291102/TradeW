'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchDhanOptionInstrument } from '@/lib/dhanLiveFeed';
import type { OptionInstrument } from './watchState';

/**
 * Resolve the CALL and PUT legs of the selection to real, addressable
 * contracts — independently, and without either being able to answer for the
 * other.
 *
 * ── WHY THE TWO LEGS ARE RESOLVED SEPARATELY ───────────────────────────────
 *
 * They change at different times. Moving the call strike must re-resolve the
 * call and leave the put's token exactly as it was, because a shared resolve
 * would tear down and rebuild a subscription the operator did not touch — the
 * same "only that leg moves" property `selectStrike` guarantees one layer up,
 * and the property the network log was checked against on 2026-08-18.
 *
 * Each leg is keyed by its OWN `symbol|expiry|strike|side`, so:
 *   - a CE request can only ever produce a CE token (the side is in the key AND
 *     re-checked in `fetchDhanOptionInstrument` and again in `attachInstrument`);
 *   - a response that arrives after the operator has moved on is discarded by
 *     comparing the key it was issued for against the key now current, rather
 *     than by a bare `cancelled` flag — a flag alone lets a slow response for
 *     the OLD strike land while the new one is still in flight.
 *
 * ── ONE CALL PER CONTRACT, NOT ONE PER POLL ────────────────────────────────
 *
 * This does NOT poll. A contract's identity is a property of the scrip master,
 * not of the market: NIFTY 18 AUG 24200 CE has the same securityId all day.
 * The chain poll (`useOptionChainStrikes`, 4s) supplies the prices; this
 * resolves once per distinct contract and is idle otherwise, which matters
 * because the bridge serialises option-family calls behind a 3.1s floor and
 * this route shares that queue's upstream budget.
 */
export type InstrumentStatus = 'idle' | 'resolving' | 'resolved' | 'unresolvable';

export interface LegInstrument {
  status: InstrumentStatus;
  instrument: OptionInstrument | null;
}

const IDLE: LegInstrument = { status: 'idle', instrument: null };

export interface PairInstruments {
  ce: LegInstrument;
  pe: LegInstrument;
}

function useLegInstrument(
  symbol: string,
  expiry: string | null,
  strike: number | null,
  side: 'CE' | 'PE',
  enabled: boolean,
): LegInstrument {
  const [state, setState] = useState<LegInstrument>(IDLE);

  // The contract this hook is currently answering about. A response is applied
  // only if its key still matches, which is what stops a late reply for a
  // superseded strike from overwriting the current one.
  const key = enabled && expiry !== null && strike !== null ? `${symbol}|${expiry}|${strike}|${side}` : null;
  const keyRef = useRef<string | null>(null);
  keyRef.current = key;

  useEffect(() => {
    if (key === null) {
      // Cleared, not left holding the previous contract's token. A leg with no
      // strike has no instrument, and keeping the old one is how a securityId
      // outlives the strike it belongs to.
      setState(IDLE);
      return;
    }

    let cancelled = false;
    setState({ status: 'resolving', instrument: null });

    void (async () => {
      const instrument = await fetchDhanOptionInstrument(symbol, expiry as string, strike as number, side);
      if (cancelled || keyRef.current !== key) return;
      setState(
        instrument
          ? { status: 'resolved', instrument }
          : // Not an error state to hide: a strike can be listed in the chain
            // and absent from the scrip master snapshot the bridge booted with.
            // The form says so and refuses to start, rather than falling back
            // to the strike number.
            { status: 'unresolvable', instrument: null },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [key, symbol, expiry, strike, side]);

  return state;
}

/**
 * Both legs, resolved independently.
 *
 * `enabled` is false for an underlying-only watch, which has no legs to
 * resolve — not "legs we have not got around to resolving".
 */
export function useOptionInstruments(
  symbol: string,
  expiry: string | null,
  callStrike: number | null,
  putStrike: number | null,
  enabled: boolean,
): PairInstruments {
  const ce = useLegInstrument(symbol, expiry, callStrike, 'CE', enabled);
  const pe = useLegInstrument(symbol, expiry, putStrike, 'PE', enabled);
  return { ce, pe };
}
