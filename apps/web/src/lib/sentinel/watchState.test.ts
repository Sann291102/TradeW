import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SELECTION,
  applyMarketHasOptions,
  instrumentLabel,
  reconcileWatchSelection,
  resolveWatchContext,
  selectExpiry,
  selectMarket,
  selectSide,
  selectStrike,
  selectionFromWatch,
  setUnderlyingOnly,
  watchMode,
  type WatchSelection,
} from './watchState';
import type { WatchSession } from './strategyApi';

function selection(over: Partial<WatchSelection> = {}): WatchSelection {
  return { ...DEFAULT_SELECTION, expiry: '2026-08-18', callStrike: 24200, putStrike: 24300, ...over };
}

/** One resolved leg, shaped as the backend returns it. */
function leg(strike: number, optionType: 'CE' | 'PE') {
  return {
    strike,
    optionType,
    securityId: `${optionType}-${strike}`,
    exchangeSegment: 'NSE_FNO',
    tradingSymbol: `NIFTY 18AUG ${strike} ${optionType}`,
    dhanInstrument: 'OPTIDX',
    lotSize: 75,
    tickSize: 0.05,
  } as const;
}

function watch(over: Partial<WatchSession> = {}): WatchSession {
  return {
    id: 'w1',
    userId: 'u1',
    strategyId: 's1',
    symbol: 'NIFTY',
    strike: '24200',
    optionType: 'CE',
    expiry: '2026-08-18',
    // A LEGACY-shaped row by default: only the mirror columns. Overridden with
    // `ce`/`pe` in the pair tests, so both shapes stay covered.
    ce: null,
    pe: null,
    focusedSide: null,
    watchMode: 'option',
    timeframe: null,
    state: 'FORMING',
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    direction: null,
    reachedMilestones: [],
    lastNotifiedAt: null,
    cooldownUntil: null,
    createdAt: '2026-08-18T04:00:00Z',
    updatedAt: '2026-08-18T04:00:00Z',
    ...over,
  };
}

describe('resolveWatchContext', () => {
  it('resolves the underlying and both legs from one selection', () => {
    const r = resolveWatchContext(selection());
    expect(r.underlying.symbol).toBe('NIFTY');
    expect(r.call).toMatchObject({ symbol: 'NIFTY', expiry: '2026-08-18', strike: 24200, optionType: 'CE' });
    expect(r.put).toMatchObject({ symbol: 'NIFTY', expiry: '2026-08-18', strike: 24300, optionType: 'PE' });
  });

  it('names each leg with its full contract identity', () => {
    const r = resolveWatchContext(selection());
    expect(r.call?.label).toBe('NIFTY 18 AUG 24200 CALL');
    expect(r.put?.label).toBe('NIFTY 18 AUG 24300 PUT');
  });

  it('has no legs at all for an underlying-only watch', () => {
    // Not "legs we have not resolved yet" — the watch deliberately excludes
    // them, and a CE panel drawn anyway would claim to be part of it.
    const r = resolveWatchContext(selection({ underlyingOnly: true }));
    expect(r.underlying.symbol).toBe('NIFTY');
    expect(r.call).toBeNull();
    expect(r.put).toBeNull();
  });

  it('has no legs before an expiry is settled', () => {
    const r = resolveWatchContext(selection({ expiry: null }));
    expect(r.call).toBeNull();
    expect(r.put).toBeNull();
  });

  it('leaves an unselected leg null rather than substituting the other one', () => {
    const r = resolveWatchContext(selection({ putStrike: null }));
    expect(r.call?.strike).toBe(24200);
    expect(r.put).toBeNull();
  });

  it('reports the underlying with no expiry or strike of its own', () => {
    const r = resolveWatchContext(selection());
    expect(r.underlying).toMatchObject({ expiry: null, strike: null, optionType: null, label: 'NIFTY' });
  });
});

describe('instrumentLabel', () => {
  it('falls back to the bare symbol when there is no contract', () => {
    expect(instrumentLabel('SENSEX', null, null, null)).toBe('SENSEX');
  });
});

describe('watchMode', () => {
  it('is derived from underlyingOnly rather than stored separately', () => {
    expect(watchMode(selection())).toBe('option');
    expect(watchMode(selection({ underlyingOnly: true }))).toBe('underlying');
  });
});

describe('selectMarket', () => {
  it('drops the expiry, both strikes and the selected watch', () => {
    // A NIFTY strike is not a SENSEX strike; carrying it over would request a
    // contract that does not exist and blame the instrument for the miss.
    const next = selectMarket(selection({ selectedWatchId: 'w1' }), 'SENSEX');
    expect(next).toMatchObject({
      symbol: 'SENSEX',
      expiry: null,
      callStrike: null,
      putStrike: null,
      underlyingOnly: false,
      selectedWatchId: null,
    });
  });

  it('clears an underlying-only flag that belonged to the previous symbol', () => {
    const next = selectMarket(selection({ underlyingOnly: true }), 'BANKNIFTY');
    expect(next.underlyingOnly).toBe(false);
  });

  it('clears the underlying CHOICE with the flag, so the new market is asked afresh', () => {
    const next = selectMarket(selection({ underlyingOnly: true, underlyingByChoice: true }), 'BANKNIFTY');
    expect(next.underlyingByChoice).toBe(false);
  });

  it('returns the same object when the market has not changed', () => {
    // Identity matters: the provider hands this straight to setState, and a new
    // object every render would restart every chart's data hook.
    const prev = selection();
    expect(selectMarket(prev, 'NIFTY')).toBe(prev);
  });
});

describe('selectExpiry', () => {
  it('keeps the market but drops both strikes', () => {
    const next = selectExpiry(selection(), '2026-08-25');
    expect(next).toMatchObject({ symbol: 'NIFTY', expiry: '2026-08-25', callStrike: null, putStrike: null });
  });

  it('returns the same object for the same expiry', () => {
    const prev = selection();
    expect(selectExpiry(prev, '2026-08-18')).toBe(prev);
  });
});

describe('selectStrike', () => {
  it('moves only the named leg', () => {
    const next = selectStrike(selection(), 'CE', 24400);
    expect(next.callStrike).toBe(24400);
    expect(next.putStrike).toBe(24300);
  });

  it('moves only the put when the put is named', () => {
    const next = selectStrike(selection(), 'PE', 24100);
    expect(next.callStrike).toBe(24200);
    expect(next.putStrike).toBe(24100);
  });

  it('returns the same object when the leg is unchanged', () => {
    const prev = selection();
    expect(selectStrike(prev, 'CE', 24200)).toBe(prev);
  });
});

describe('selectSide and setUnderlyingOnly', () => {
  it('changing the side leaves both strikes alone', () => {
    const next = selectSide(selection(), 'PE');
    expect(next.focusedSide).toBe('PE');
    expect(next.callStrike).toBe(24200);
    expect(next.putStrike).toBe(24300);
  });

  it('are both no-ops for an unchanged value', () => {
    const prev = selection();
    expect(selectSide(prev, 'CE')).toBe(prev);
    expect(setUnderlyingOnly(prev, false)).toBe(prev);
  });
});

describe('applyMarketHasOptions', () => {
  it('forces the underlying when the market confirms it has no option chain', () => {
    const next = applyMarketHasOptions(selection(), false);
    expect(next.underlyingOnly).toBe(true);
    expect(next.underlyingByChoice).toBe(false);
  });

  it('RELEASES a forced flag once a chain turns out to exist', () => {
    // The 2026-08-29 bug: one 'none' latched the flag, localStorage kept it,
    // and the CE/PE strike pickers stayed hidden on a market with options.
    const forced = applyMarketHasOptions(selection(), false);
    expect(applyMarketHasOptions(forced, true).underlyingOnly).toBe(false);
  });

  it('never overrides a flag the operator set deliberately', () => {
    const chosen = setUnderlyingOnly(selection(), true);
    expect(applyMarketHasOptions(chosen, true)).toBe(chosen);
  });

  it('re-forces the underlying when the operator unticks it on an optionless market', () => {
    // Not a regression: there is no option to watch, so the flag is the truth
    // rather than a preference. Only a market WITH a chain can honour the untick.
    const cleared = setUnderlyingOnly(applyMarketHasOptions(selection(), false), false);
    expect(applyMarketHasOptions(cleared, false).underlyingOnly).toBe(true);
  });
});

describe('watchMatchesSelection', () => {
  it('matches a watch on the selected call leg', () => {
    expect(reconcileWatchSelection(selection(), [watch()])).toBe('w1');
  });

  it('matches a put watch against the selected PUT leg, whatever the side toggle says', () => {
    // The panel draws both legs, so a put watch on the selected put strike is
    // genuinely the watch for what is on screen.
    const w = watch({ id: 'p1', optionType: 'PE', strike: '24300' });
    expect(reconcileWatchSelection(selection({ focusedSide: 'CE' }), [w])).toBe('p1');
  });

  it('does not match a watch on a different strike', () => {
    expect(reconcileWatchSelection(selection(), [watch({ strike: '24350' })])).toBeNull();
  });

  it('does not match a watch on a different market', () => {
    expect(reconcileWatchSelection(selection(), [watch({ symbol: 'BANKNIFTY' })])).toBeNull();
  });

  it('does not match a watch on a different expiry', () => {
    expect(reconcileWatchSelection(selection(), [watch({ expiry: '2026-08-25' })])).toBeNull();
  });

  it('matches an underlying watch only against an underlying selection', () => {
    const w = watch({ strike: null, optionType: null, expiry: null });
    expect(reconcileWatchSelection(selection(), [w])).toBeNull();
    expect(reconcileWatchSelection(selection({ underlyingOnly: true }), [w])).toBe('w1');
  });

  it('does not match an option watch against an underlying selection', () => {
    expect(reconcileWatchSelection(selection({ underlyingOnly: true }), [watch()])).toBeNull();
  });
});

describe('reconcileWatchSelection', () => {
  it('drops a selected watch that no longer exists', () => {
    expect(reconcileWatchSelection(selection({ selectedWatchId: 'gone' }), [])).toBeNull();
  });

  it('drops a selected watch that no longer describes the selection', () => {
    // The operator moved the call leg to 24400; the watch on 24200 is still
    // running server-side but is no longer what the screen is showing.
    const sel = selection({ selectedWatchId: 'w1', callStrike: 24400 });
    expect(reconcileWatchSelection(sel, [watch()])).toBeNull();
  });

  it('prefers a live watch over a closed one on the same contract', () => {
    const closed = watch({ id: 'old', state: 'EXITED' });
    const live = watch({ id: 'new', state: 'CONFIRMED' });
    expect(reconcileWatchSelection(selection(), [closed, live])).toBe('new');
  });

  it('keeps a still-valid selection rather than re-picking every poll', () => {
    const sel = selection({ selectedWatchId: 'w1' });
    const other = watch({ id: 'w2', state: 'CONFIRMED' });
    expect(reconcileWatchSelection(sel, [watch(), other])).toBe('w1');
  });
});

describe('selectionFromWatch', () => {
  it('repoints the whole selection at the watch instrument', () => {
    const next = selectionFromWatch(DEFAULT_SELECTION, watch({ symbol: 'BANKNIFTY', strike: '52000' }));
    expect(next).toMatchObject({
      symbol: 'BANKNIFTY',
      expiry: '2026-08-18',
      focusedSide: 'CE',
      callStrike: 52000,
      underlyingOnly: false,
      selectedWatchId: 'w1',
    });
  });

  // ⚠️ BEHAVIOUR REVERSED 2026-08-18, deliberately.
  //
  // This block previously asserted that adopting a watch pinned BOTH legs to
  // the watch's single strike. That was the least-wrong guess available while a
  // watch could only name one leg and the panel had to draw two charts from it.
  // A watch now carries a real pair, so mirroring would overwrite a put the
  // operator had deliberately chosen with a copy of the call — the overwrite
  // the dual-strike work exists to remove. The assertions are inverted rather
  // than deleted: a deleted test cannot fail if someone restores the mirror.
  it('adopts only the legs the watch actually names', () => {
    const next = selectionFromWatch(selection(), watch({ strike: '24400', optionType: 'CE' }));
    expect(next.callStrike).toBe(24400);
    // The watch says nothing about a put, so the operator's put survives.
    expect(next.putStrike).toBe(24300);
  });

  it('adopts both legs of a pair watch', () => {
    const next = selectionFromWatch(
      selection(),
      watch({ ce: leg(24400, 'CE'), pe: leg(24150, 'PE'), focusedSide: 'PE' }),
    );
    expect(next.callStrike).toBe(24400);
    expect(next.putStrike).toBe(24150);
    expect(next.callInstrument?.securityId).toBe('CE-24400');
    expect(next.putInstrument?.securityId).toBe('PE-24150');
    expect(next.focusedSide).toBe('PE');
  });

  it('drops an unnamed leg carried over from a DIFFERENT market', () => {
    // A NIFTY put strike left sitting in a BANKNIFTY selection looks plausible,
    // resolves to no instrument, and blocks the form with a fault the operator
    // never caused.
    const next = selectionFromWatch(selection(), watch({ symbol: 'BANKNIFTY', strike: '52000' }));
    expect(next).toMatchObject({ symbol: 'BANKNIFTY', callStrike: 52000, putStrike: null });
  });

  it('makes an underlying watch an underlying selection with no legs', () => {
    const next = selectionFromWatch(selection(), watch({ strike: null, optionType: null, expiry: null }));
    expect(next).toMatchObject({ underlyingOnly: true, callStrike: null, putStrike: null, expiry: null });
  });

  it('treats an unparseable strike as no leg rather than NaN', () => {
    const next = selectionFromWatch(selection(), watch({ strike: 'not-a-number' }));
    expect(next.underlyingOnly).toBe(true);
    expect(next.callStrike).toBeNull();
  });
});
