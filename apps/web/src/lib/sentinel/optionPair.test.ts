/**
 * The dual-strike invariants.
 *
 * Sentinel observes three series together — the underlying, a CALL and a PUT —
 * and decides which leg is expressing the underlying's move. Every assertion
 * here protects some part of "the pair reaches the engine intact": both legs
 * configurable independently, neither able to overwrite the other, neither able
 * to become the other's contract, and no path that collapses them back into one
 * strike.
 *
 * The failure this replaced is worth naming, because it was invisible: the form
 * had ONE strike dropdown and the CE/PE toggle chose which leg it edited, so
 * the toggle silently decided which single leg the engine ever received. The
 * screen showed two charts throughout.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SELECTION,
  attachInstrument,
  buildWatchRequest,
  canStartWatch,
  instrumentDescribes,
  resolveWatchContext,
  selectExpiry,
  selectMarket,
  selectSide,
  selectStrike,
  validateWatchPair,
  watchLegs,
  watchPairLabel,
  type OptionInstrument,
  type PairLadders,
  type WatchSelection,
} from './watchState';

const TODAY = '2026-08-18';
const NOW = 1_755_000_000_000;

function instrument(strike: number, optionType: 'CE' | 'PE', over: Partial<OptionInstrument> = {}): OptionInstrument {
  return {
    securityId: `${optionType}-${strike}`,
    exchangeSegment: 'NSE_FNO',
    dhanInstrument: 'OPTIDX',
    tradingSymbol: `NIFTY 18AUG ${strike} ${optionType}`,
    displayName: `NIFTY ${strike} ${optionType}`,
    underlying: 'NIFTY',
    expiry: '2026-08-18',
    strike,
    optionType,
    lotSize: 75,
    tickSize: 0.05,
    ...over,
  };
}

/** A fully configured pair — both legs chosen AND both resolved. */
function configured(over: Partial<WatchSelection> = {}): WatchSelection {
  return {
    ...DEFAULT_SELECTION,
    expiry: '2026-08-18',
    callStrike: 24_200,
    putStrike: 24_100,
    callInstrument: instrument(24_200, 'CE'),
    putInstrument: instrument(24_100, 'PE'),
    ...over,
  };
}

function ladders(over: Partial<PairLadders> = {}): PairLadders {
  const rows = [24_100, 24_150, 24_200, 24_250].map((strike) => ({ strike }));
  return { status: 'live', ce: rows, pe: rows, fetchedAt: NOW - 1_000, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CE and PE can be selected independently
// ─────────────────────────────────────────────────────────────────────────────

describe('1 — the two legs are configured independently', () => {
  it('holds a call and a put at different strikes at the same time', () => {
    const s = configured();
    expect(s.callStrike).toBe(24_200);
    expect(s.putStrike).toBe(24_100);
  });

  it('resolves both to their own contract, each with its own token', () => {
    const r = resolveWatchContext(configured());
    expect(r.call).toMatchObject({ strike: 24_200, optionType: 'CE' });
    expect(r.put).toMatchObject({ strike: 24_100, optionType: 'PE' });
    expect(r.call?.instrument?.securityId).toBe('CE-24200');
    expect(r.put?.instrument?.securityId).toBe('PE-24100');
  });

  it('the side toggle is FOCUS — it creates and destroys no leg', () => {
    // The whole point of the redesign. Under the old model this control chose
    // which single strike existed.
    const s = selectSide(configured(), 'PE');
    expect(s.focusedSide).toBe('PE');
    expect(s.callStrike).toBe(24_200);
    expect(s.putStrike).toBe(24_100);
    expect(s.callInstrument?.securityId).toBe('CE-24200');
    expect(s.putInstrument?.securityId).toBe('PE-24100');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. Neither side can produce the other's instrument
// ─────────────────────────────────────────────────────────────────────────────

describe('2 & 3 — a leg cannot hold the opposite side’s contract', () => {
  it('refuses a PE token offered to the call leg', () => {
    const s = configured({ callInstrument: null });
    const attacked = attachInstrument(s, 'CE', instrument(24_200, 'PE'));
    expect(attacked.callInstrument).toBeNull();
  });

  it('refuses a CE token offered to the put leg', () => {
    const s = configured({ putInstrument: null });
    const attacked = attachInstrument(s, 'PE', instrument(24_100, 'CE'));
    expect(attacked.putInstrument).toBeNull();
  });

  it('a mismatched side is never treated as describing the leg', () => {
    expect(instrumentDescribes(instrument(24_200, 'PE'), 'NIFTY', '2026-08-18', 24_200, 'CE')).toBe(false);
    expect(instrumentDescribes(instrument(24_200, 'CE'), 'NIFTY', '2026-08-18', 24_200, 'CE')).toBe(true);
  });

  it('a wrong-side token already in the selection is dropped by the resolver, not drawn', () => {
    // Defence in depth: even if a bad token reached state, nothing addressable
    // comes out the other end.
    const r = resolveWatchContext(configured({ callInstrument: instrument(24_200, 'PE') }));
    expect(r.call?.strike).toBe(24_200);
    expect(r.call?.instrument).toBeNull();
  });

  it('refuses a token for a different strike, expiry or underlying', () => {
    const s = configured({ callInstrument: null });
    expect(attachInstrument(s, 'CE', instrument(24_250, 'CE')).callInstrument).toBeNull();
    expect(attachInstrument(s, 'CE', instrument(24_200, 'CE', { expiry: '2026-08-25' })).callInstrument).toBeNull();
    expect(attachInstrument(s, 'CE', instrument(24_200, 'CE', { underlying: 'SENSEX' })).callInstrument).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Both instruments survive state changes
// ─────────────────────────────────────────────────────────────────────────────

describe('4 — both legs survive unrelated state changes', () => {
  it('survives a focus change', () => {
    const s = selectSide(selectSide(configured(), 'PE'), 'CE');
    expect(s.callInstrument?.securityId).toBe('CE-24200');
    expect(s.putInstrument?.securityId).toBe('PE-24100');
  });

  it('survives re-attaching an identical token (same object returned, no churn)', () => {
    const s = configured();
    expect(attachInstrument(s, 'CE', instrument(24_200, 'CE'))).toBe(s);
  });

  it('is dropped ONLY where it stops being true — a market or expiry change', () => {
    // Not a survival exception: a NIFTY token is not a SENSEX token, and the
    // 24200 of one series is a different contract from the 24200 of the next.
    expect(selectMarket(configured(), 'SENSEX')).toMatchObject({
      callStrike: null,
      putStrike: null,
      callInstrument: null,
      putInstrument: null,
    });
    expect(selectExpiry(configured(), '2026-08-25')).toMatchObject({
      callStrike: null,
      putStrike: null,
      callInstrument: null,
      putInstrument: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Start Watching sends both instruments
// ─────────────────────────────────────────────────────────────────────────────

describe('5 — the Start Watching payload carries the whole pair', () => {
  // `WatchCreator.handleStart` submits exactly `buildWatchRequest(...)` and
  // assembles nothing of its own, so this is the payload that goes on the wire.
  it('sends both legs with their instrument identity', () => {
    const req = buildWatchRequest(configured(), 'strategy-1', '15m');
    expect(req.ce).toMatchObject({ strike: 24_200, optionType: 'CE', securityId: 'CE-24200' });
    expect(req.pe).toMatchObject({ strike: 24_100, optionType: 'PE', securityId: 'PE-24100' });
  });

  it('sends every field the watch configuration is specified to contain', () => {
    const req = buildWatchRequest(configured({ focusedSide: 'PE' }), 'strategy-1', '5m');
    expect(req.symbol).toBe('NIFTY');
    expect(req.expiry).toBe('2026-08-18');
    expect(req.timeframe).toBe('5m');
    expect(req.focusedSide).toBe('PE');
    expect(req.watchMode).toBe('option');
    expect(req.strategyId).toBe('strategy-1');
  });

  it('carries the exchange segment, instrument class, lot and tick per leg', () => {
    const req = buildWatchRequest(configured(), 'strategy-1', '15m');
    for (const leg of [req.ce, req.pe]) {
      expect(leg?.exchangeSegment).toBe('NSE_FNO');
      expect(leg?.dhanInstrument).toBe('OPTIDX');
      expect(leg?.lotSize).toBe(75);
      expect(leg?.tickSize).toBe(0.05);
    }
  });

  it('omits a leg whose token is STALE rather than sending a mismatched one', () => {
    // Absent-and-refused beats present-and-wrong: validation then blocks the
    // request instead of the engine watching a contract nobody chose.
    const stale = configured({ callInstrument: instrument(24_250, 'CE') });
    expect(buildWatchRequest(stale, 's1', '15m').ce).toBeNull();
    expect(canStartWatch(stale, ladders(), NOW, TODAY)).toBe(false);
  });

  it('an underlying watch carries no legs at all — not half a pair', () => {
    const req = buildWatchRequest(configured({ underlyingOnly: true }), 's1', '15m');
    expect(req).toMatchObject({ watchMode: 'underlying', ce: null, pe: null, expiry: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 & 10. Neither leg overwrites the other
// ─────────────────────────────────────────────────────────────────────────────

describe('9 & 10 — moving one leg never disturbs the other', () => {
  it('changing CE leaves the PE strike and token untouched', () => {
    const s = selectStrike(configured(), 'CE', 24_250);
    expect(s.callStrike).toBe(24_250);
    // The call's own token is cleared — it described the strike just left.
    expect(s.callInstrument).toBeNull();
    expect(s.putStrike).toBe(24_100);
    expect(s.putInstrument?.securityId).toBe('PE-24100');
  });

  it('changing PE leaves the CE strike and token untouched', () => {
    const s = selectStrike(configured(), 'PE', 24_250);
    expect(s.putStrike).toBe(24_250);
    expect(s.putInstrument).toBeNull();
    expect(s.callStrike).toBe(24_200);
    expect(s.callInstrument?.securityId).toBe('CE-24200');
  });

  it('survives a long alternating sequence with no cross-contamination', () => {
    let s = configured();
    for (const strike of [24_150, 24_200, 24_250]) {
      s = attachInstrument(selectStrike(s, 'CE', strike), 'CE', instrument(strike, 'CE'));
      expect(s.putStrike).toBe(24_100);
      expect(s.putInstrument?.securityId).toBe('PE-24100');
    }
    for (const strike of [24_150, 24_250]) {
      s = attachInstrument(selectStrike(s, 'PE', strike), 'PE', instrument(strike, 'PE'));
      expect(s.callStrike).toBe(24_250);
      expect(s.callInstrument?.securityId).toBe('CE-24250');
    }
    expect(s.putStrike).toBe(24_250);
    expect(s.putInstrument?.securityId).toBe('PE-24250');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Invalid selections are rejected, never substituted
// ─────────────────────────────────────────────────────────────────────────────

describe('11 — every invalid configuration is refused with its own reason', () => {
  it('blocks a missing CE leg and names the side', () => {
    const problems = validateWatchPair(configured({ callStrike: null, callInstrument: null }), ladders(), NOW, TODAY);
    expect(problems).toContainEqual(expect.objectContaining({ code: 'strike-missing', side: 'CE' }));
  });

  it('blocks a missing PE leg and names the side', () => {
    const problems = validateWatchPair(configured({ putStrike: null, putInstrument: null }), ladders(), NOW, TODAY);
    expect(problems).toContainEqual(expect.objectContaining({ code: 'strike-missing', side: 'PE' }));
  });

  it('blocks an expired contract', () => {
    const problems = validateWatchPair(configured({ expiry: '2026-08-11' }), ladders(), NOW, TODAY);
    expect(problems[0]).toMatchObject({ code: 'expired' });
  });

  it('blocks a strike that is not in the live chain', () => {
    const problems = validateWatchPair(
      configured({ callStrike: 24_337, callInstrument: instrument(24_337, 'CE') }),
      ladders(),
      NOW,
      TODAY,
    );
    expect(problems).toContainEqual(expect.objectContaining({ code: 'strike-not-listed', side: 'CE' }));
  });

  it('blocks a strike listed on the OTHER side only', () => {
    // 24250 trades as a put here but not as a call; the call leg must refuse it.
    const asymmetric = ladders({ ce: [{ strike: 24_100 }, { strike: 24_200 }] });
    const problems = validateWatchPair(
      configured({ callStrike: 24_250, callInstrument: instrument(24_250, 'CE') }),
      asymmetric,
      NOW,
      TODAY,
    );
    expect(problems).toContainEqual(expect.objectContaining({ code: 'strike-not-listed', side: 'CE' }));
  });

  it('blocks an unresolved instrument', () => {
    const problems = validateWatchPair(configured({ putInstrument: null }), ladders(), NOW, TODAY);
    expect(problems).toContainEqual(expect.objectContaining({ code: 'instrument-unresolved', side: 'PE' }));
  });

  it('blocks an instrument/token mismatch', () => {
    const problems = validateWatchPair(
      // A token that describes a listed contract — just not this leg's.
      configured({ callInstrument: instrument(24_150, 'CE') }),
      ladders(),
      NOW,
      TODAY,
    );
    // A token that exists but names another contract is a MISMATCH, reported
    // separately from a leg that resolved to nothing — the two have different
    // causes and different fixes.
    expect(problems).toContainEqual(expect.objectContaining({ code: 'instrument-mismatch', side: 'CE' }));
  });

  it('blocks an unavailable or still-loading chain', () => {
    expect(validateWatchPair(configured(), ladders({ status: 'unavailable' }), NOW, TODAY)[0]).toMatchObject({
      code: 'chain-unavailable',
    });
    expect(validateWatchPair(configured(), ladders({ status: 'loading' }), NOW, TODAY)[0]).toMatchObject({
      code: 'chain-loading',
    });
  });

  it('blocks a STALE chain — strikes that cannot be confirmed as still listed', () => {
    const old = ladders({ fetchedAt: NOW - 120_000 });
    expect(validateWatchPair(configured(), old, NOW, TODAY)[0]).toMatchObject({ code: 'chain-stale' });
    expect(validateWatchPair(configured(), ladders({ fetchedAt: null }), NOW, TODAY)[0]).toMatchObject({
      code: 'chain-stale',
    });
  });

  it('blocks a missing expiry', () => {
    expect(validateWatchPair(configured({ expiry: null }), ladders(), NOW, TODAY)[0]).toMatchObject({
      code: 'no-expiry',
    });
  });

  it('reports BOTH legs at once rather than one fault at a time', () => {
    const problems = validateWatchPair(
      configured({ callStrike: null, callInstrument: null, putStrike: null, putInstrument: null }),
      ladders(),
      NOW,
      TODAY,
    );
    expect(problems.map((p) => p.side).sort()).toEqual(['CE', 'PE']);
  });

  it('allows the watch only when BOTH legs are valid and addressable', () => {
    expect(canStartWatch(configured(), ladders(), NOW, TODAY)).toBe(true);
    expect(canStartWatch(configured({ putInstrument: null }), ladders(), NOW, TODAY)).toBe(false);
    expect(canStartWatch(configured({ callInstrument: null }), ladders(), NOW, TODAY)).toBe(false);
  });

  it('an underlying watch has no contracts to be wrong about', () => {
    expect(validateWatchPair(configured({ underlyingOnly: true }), ladders({ status: 'unavailable' }), NOW, TODAY))
      .toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. No legacy single-strike path remains active
// ─────────────────────────────────────────────────────────────────────────────

describe('12 — no single-strike path survives', () => {
  it('the request has no top-level strike/optionType/selectedStrike field', () => {
    const req = buildWatchRequest(configured(), 's1', '15m') as unknown as Record<string, unknown>;
    expect(req).not.toHaveProperty('strike');
    expect(req).not.toHaveProperty('optionType');
    expect(req).not.toHaveProperty('selectedStrike');
  });

  it('a request can never describe one leg — both or neither', () => {
    // The only null-leg shape the builder can produce is the underlying watch,
    // where BOTH are null. A half pair is what validation refuses.
    const halfPair = configured({ putStrike: null, putInstrument: null });
    const req = buildWatchRequest(halfPair, 's1', '15m');
    expect(req.pe).toBeNull();
    expect(canStartWatch(halfPair, ladders(), NOW, TODAY)).toBe(false);
  });

  it('reads a LEGACY single-leg row through the shim, never as a complete pair', () => {
    const legacyRow = {
      symbol: 'NIFTY',
      expiry: '2026-08-18',
      strike: '24200',
      optionType: 'CE' as const,
      ce: null,
      pe: null,
      focusedSide: null,
    };
    const legs = watchLegs(legacyRow);
    expect(legs.legacy).toBe(true);
    expect(legs.ce?.strike).toBe(24_200);
    // The row says nothing about a put, and the shim invents nothing.
    expect(legs.pe).toBeNull();
    // Nor does it fabricate a token it never had.
    expect(legs.ce?.securityId).toBe('');
  });

  it('names a pair watch with BOTH legs, and a legacy row with the one it has', () => {
    const pairLeg = (strike: number, optionType: 'CE' | 'PE') => ({
      strike,
      optionType,
      securityId: `${optionType}-${strike}`,
      exchangeSegment: 'NSE_FNO',
      tradingSymbol: '',
      dhanInstrument: 'OPTIDX',
      lotSize: 75,
      tickSize: 0.05,
    });
    expect(
      watchPairLabel({
        symbol: 'NIFTY',
        expiry: '2026-08-18',
        ce: pairLeg(24_200, 'CE'),
        pe: pairLeg(24_100, 'PE'),
      }),
    ).toBe('NIFTY 18 AUG 24200 CE / 24100 PE');

    expect(watchPairLabel({ symbol: 'NIFTY', expiry: '2026-08-18', strike: '24200', optionType: 'CE' })).toBe(
      'NIFTY 18 AUG 24200 CE',
    );
  });
});
