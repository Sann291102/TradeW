import { describe, expect, it } from 'vitest';
import { engineFocusFrom, focusFromTimeline, resolveSeries, seriesNote } from './chartFocus';
import type { ContractWatch } from './types';
import type { Timeline } from './sentinelPy';

function timeline(watch: Partial<Timeline['watch']>): Timeline {
  return {
    watch: {
      id: 'w1',
      symbol: 'NIFTY',
      strike: '24350',
      optionType: 'CE',
      expiry: '2026-08-21',
      state: 'FORMING',
      direction: null,
      strategyId: 's1',
      timeframe: '15m',
      // No position declared — the state every watch starts in.
      entryPrice: null,
      invalidationPrice: null,
      projectedPrice: null,
      ...watch,
    },
    conditions: [],
    reading: null,
    events: [],
  };
}

describe('resolveSeries', () => {
  it('passes a timeframe the bridge carries straight through', () => {
    const s = resolveSeries('15m');
    expect(s.interval).toBe('15m');
    expect(s.substituted).toBe(false);
    expect(s.assumedDefault).toBe(false);
  });

  it("reproduces the bridge's silent 5m substitution for a timeframe it cannot serve", () => {
    // The engine requests 3m, the bridge has no 3m series and returns 5m bars
    // with no error anywhere in the chain. Drawing 3m here would show the user
    // bars the engine never read.
    const s = resolveSeries('3m');
    expect(s.interval).toBe('5m');
    expect(s.requested).toBe('3m');
    expect(s.substituted).toBe(true);
  });

  it('says so in plain words rather than drawing the substitution silently', () => {
    expect(seriesNote(resolveSeries('3m'))).toContain('no 3m series');
    expect(seriesNote(resolveSeries('3m'))).toContain('5m');
  });

  it("falls back to the engine's own default when the strategy names no timeframe", () => {
    const s = resolveSeries(null);
    expect(s.interval).toBe('15m');
    expect(s.assumedDefault).toBe(true);
    expect(s.requested).toBeNull();
    expect(s.substituted).toBe(false);
  });

  it('normalises case and stray whitespace', () => {
    expect(resolveSeries(' 1H ').interval).toBe('1h');
    expect(resolveSeries(' 1H ').substituted).toBe(false);
  });

  it('loads history proportional to the interval', () => {
    expect(resolveSeries('1m').days).toBeLessThan(resolveSeries('1d').days);
    expect(resolveSeries('15m').minutes).toBe(15);
  });
});

describe('focusFromTimeline', () => {
  it('carries the contract the sweep reads', () => {
    const focus = focusFromTimeline(timeline({}));
    expect(focus).toMatchObject({
      watchId: 'w1',
      symbol: 'NIFTY',
      strike: 24350,
      optionType: 'CE',
      expiry: '2026-08-21',
    });
    expect(focus?.series.interval).toBe('15m');
  });

  it('keeps an index watch strikeless rather than defaulting a strike in', () => {
    // A watch with no strike reads the INDEX (see `_candles_for` in the
    // poller). Inventing an ATM strike here would claim the engine is reading
    // a contract it has never fetched.
    const focus = focusFromTimeline(timeline({ strike: null, optionType: null }));
    expect(focus?.strike).toBeNull();
    expect(focus?.optionType).toBeNull();
  });

  it('treats an unparseable strike as no strike', () => {
    expect(focusFromTimeline(timeline({ strike: 'ATM' }))?.strike).toBeNull();
  });

  it('is null with no timeline, so the charts fall back to their own selection', () => {
    expect(focusFromTimeline(null)).toBeNull();
  });
});

/**
 * The SECOND focus — what `/observe` read for the selected market.
 *
 * Every assertion here is about one property: the "Sentinel reads this" badge
 * must be earned per panel. The panel it sits on is a chart of a specific
 * instrument, so a badge on a series the engine did not fetch is a false
 * statement about the engine, which is the whole class of bug this module
 * exists to close.
 */
describe('engineFocusFrom', () => {
  const watch = (over: Partial<ContractWatch> = {}): ContractWatch => ({
    underlying: 'NIFTY',
    expiry: '2026-08-27',
    strike: 24_350,
    interval: '15m',
    index: { bars: 20, open: 24_000, last: 24_200, changePct: 0.83, direction: 'rising' },
    ce: {
      side: 'CE',
      strike: 24_350,
      series: { bars: 20, open: 100, last: 140, changePct: 40, direction: 'rising' },
      unavailableReason: null,
    },
    pe: {
      side: 'PE',
      strike: 24_350,
      series: { bars: 20, open: 100, last: 60, changePct: -40, direction: 'falling' },
      unavailableReason: null,
    },
    alignment: 'call-side-tracking',
    notes: [],
    contractsReadable: true,
    ...over,
  });

  it('is null with no contract read, so the charts keep their own selection', () => {
    expect(engineFocusFrom(null)).toBeNull();
    expect(engineFocusFrom(undefined)).toBeNull();
  });

  it('marks all three panels when the engine read all three', () => {
    const f = engineFocusFrom(watch());
    expect(f?.reads).toEqual({ index: true, ce: true, pe: true });
    expect(f?.strike).toBe(24_350);
    expect(f?.series.interval).toBe('15m');
  });

  it('does not mark a leg the engine failed to read', () => {
    // The badge is the claim. A PUT chart the browser fetched, beside a PUT
    // the engine could not fetch, must not be captioned as one Sentinel reads.
    const f = engineFocusFrom(
      watch({ pe: { side: 'PE', strike: 24_350, series: null, unavailableReason: 'no traded candles' } }),
    );
    expect(f?.reads).toEqual({ index: true, ce: true, pe: false });
  });

  it('marks nothing when the provider cannot read contracts at all', () => {
    const f = engineFocusFrom(watch({ ce: null, pe: null, strike: null, contractsReadable: false }));
    expect(f?.reads).toEqual({ index: true, ce: false, pe: false });
    expect(f?.contractsReadable).toBe(false);
  });

  it('reproduces the bridge substitution on the engine’s own interval', () => {
    // Same rule as a watch focus: the engine asking for 3m receives 5m bars,
    // so the chart draws 5m and `substituted` carries the discrepancy.
    const f = engineFocusFrom(watch({ interval: '3m' }));
    expect(f?.series.interval).toBe('5m');
    expect(f?.series.substituted).toBe(true);
  });
});
