import { describe, expect, it } from 'vitest';
import {
  hasNoPricedQuotes,
  isPricedQuote,
  withPricedQuotes,
  type DhanLiveQuote,
  type DhanLiveSnapshot,
} from './dhanLiveFeed';

/**
 * The zero guard.
 *
 * This is regression cover for a defect that has now reached the home screen
 * twice: the market-data bridge shipped quotes it had no price for, carrying
 * `ltp: 0`, and every dashboard widget rendered them as prices — `0.00` under
 * NIFTY 50, BANK NIFTY, FIN NIFTY, BSE SENSEX and INDIA VIX, beside a badge
 * reading MARKET CLOSED rather than one saying the feed could not be read.
 *
 * The second occurrence (2026-08-31, commit ef33b43) seeded a zero placeholder
 * for every tracked instrument at boot so the snapshot would "never be empty".
 * Empty was the signal. A non-empty snapshot is how every widget decides the
 * feed is real, so filling it with zeros did not make the dashboard robust —
 * it made it confidently wrong.
 *
 * The assertions below are written against the SHAPE of that payload, not
 * against the commit, because the next reintroduction will not look like the
 * last one. A price of zero is never a price; it is the absence of one, and it
 * must never survive as a row.
 */

function quote(symbol: string, ltp: number): DhanLiveQuote {
  return {
    instrumentId: `sec-${symbol}`,
    symbol,
    displayName: symbol,
    ltp,
    change: 0,
    changePct: 0,
    open: null,
    high: null,
    low: null,
    close: null,
    bid: 0,
    ask: 0,
    volume: 0,
    marketStatus: 'closed',
    updatedAt: '2026-08-31T00:00:00.000Z',
    source: 'dhan',
  };
}

function snapshot(partial: Partial<DhanLiveSnapshot> = {}): DhanLiveSnapshot {
  return { marketOpen: false, indices: [], stocks: [], etfs: [], commodities: [], ...partial };
}

/** The exact payload the boot seeding produced: the full universe, priceless. */
const SEEDED_ZERO_SNAPSHOT = snapshot({
  indices: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'INDIAVIX'].map((s) => quote(s, 0)),
  stocks: ['RELIANCE', 'INFY', 'HDFCBANK'].map((s) => quote(s, 0)),
  etfs: [quote('NIFTYBEES', 0)],
  commodities: [quote('GOLD', 0)],
});

describe('isPricedQuote', () => {
  it('rejects a zero LTP — no instrument on this feed trades at zero', () => {
    expect(isPricedQuote(quote('NIFTY', 0))).toBe(false);
  });

  it('rejects a negative LTP', () => {
    expect(isPricedQuote(quote('NIFTY', -1))).toBe(false);
  });

  it('rejects NaN and Infinity — a parse failure is not a price either', () => {
    expect(isPricedQuote(quote('NIFTY', Number.NaN))).toBe(false);
    expect(isPricedQuote(quote('NIFTY', Number.POSITIVE_INFINITY))).toBe(false);
  });

  it('rejects a missing LTP even though the type says it cannot be missing', () => {
    // The bridge is a separate process on the far side of HTTP. Its payload is
    // typed here by assertion, not by the compiler, so the runtime check has to
    // hold for values the type claims are impossible.
    expect(isPricedQuote({ ...quote('NIFTY', 0), ltp: undefined as unknown as number })).toBe(false);
  });

  it('accepts a real price, including a small one (INDIA VIX trades in the teens)', () => {
    expect(isPricedQuote(quote('NIFTY', 24_836.3))).toBe(true);
    expect(isPricedQuote(quote('INDIAVIX', 11.42))).toBe(true);
  });
});

describe('withPricedQuotes', () => {
  it('drops priceless rows from every group and keeps the real ones', () => {
    const mixed = snapshot({
      marketOpen: true,
      indices: [quote('NIFTY', 24_836.3), quote('SENSEX', 0)],
      stocks: [quote('RELIANCE', 0), quote('INFY', 1_540.2)],
      etfs: [quote('NIFTYBEES', 0)],
      commodities: [quote('GOLD', 71_240)],
    });

    const priced = withPricedQuotes(mixed);

    expect(priced.indices.map((q) => q.symbol)).toEqual(['NIFTY']);
    expect(priced.stocks.map((q) => q.symbol)).toEqual(['INFY']);
    expect(priced.etfs).toEqual([]);
    expect(priced.commodities.map((q) => q.symbol)).toEqual(['GOLD']);
    expect(priced.marketOpen).toBe(true);
  });

  it('drops rather than zeroes, so a widget sees an absent symbol and not a price of zero', () => {
    // The distinction is the whole fix. A widget that looks its symbol up in
    // the snapshot must MISS, so it takes its own fallback path; a row present
    // at zero is one every widget will happily render.
    const priced = withPricedQuotes(SEEDED_ZERO_SNAPSHOT);
    expect(priced.indices.find((q) => q.symbol === 'NIFTY')).toBeUndefined();
  });

  it('leaves a fully real snapshot untouched', () => {
    const real = snapshot({ indices: [quote('NIFTY', 24_836.3), quote('BANKNIFTY', 54_112.9)] });
    expect(withPricedQuotes(real).indices).toHaveLength(2);
  });
});

describe('hasNoPricedQuotes', () => {
  it('treats the seeded all-zero universe as no data at all', () => {
    // THE REGRESSION. Before the guard this snapshot was "non-empty", so the
    // feed reported healthy and the index cards drew 0.00.
    expect(hasNoPricedQuotes(SEEDED_ZERO_SNAPSHOT)).toBe(true);
  });

  it('treats a genuinely empty snapshot the same way', () => {
    expect(hasNoPricedQuotes(snapshot())).toBe(true);
  });

  it('is false as soon as one real price exists anywhere in the snapshot', () => {
    expect(hasNoPricedQuotes(snapshot({ commodities: [quote('GOLD', 71_240)] }))).toBe(false);
    expect(
      hasNoPricedQuotes({
        ...SEEDED_ZERO_SNAPSHOT,
        indices: [...SEEDED_ZERO_SNAPSHOT.indices, quote('NIFTY50', 24_836.3)],
      }),
    ).toBe(false);
  });
});
