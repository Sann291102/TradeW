import { describe, expect, it } from 'vitest';

import type { DhanLiveQuote } from '@/lib/dhanLiveFeed';
import { directionOf, toDisplayRow } from '@/lib/markets/quoteDisplay';
import { fmtPrice, pctOrDash, changeOrDash, NO_VALUE } from '@/lib/format';

/**
 * THE LAST LEG OF THE MARKET-CLOSED PRICE PATH.
 *
 * `packages/market-data/src/quotes/last-price.spec.ts` proves the backend half:
 * real Dhan bytes -> parser -> last-price store -> the JSON the bridge serves.
 * This file starts from that JSON and proves the browser renders it honestly.
 *
 * The defect it covers, from the report: with the market shut, the index cards
 * read "0.00". Every previous attempt at a fix was a `price || previousPrice`
 * or a `?? 0` at one more component, which is why it kept coming back — there
 * were eight surfaces mapping the same feed. There is now one projection, and
 * these are its rules.
 */

/** A quote in the shape the bridge actually serves. */
function quote(overrides: Partial<DhanLiveQuote>): DhanLiveQuote {
  return {
    instrumentId: '13',
    symbol: 'NIFTY',
    displayName: 'Nifty 50',
    ltp: null,
    previousClose: null,
    change: null,
    changePct: null,
    open: null,
    high: null,
    low: null,
    close: null,
    bid: null,
    ask: null,
    volume: null,
    priceSource: null,
    session: null,
    marketStatus: 'closed',
    updatedAt: null,
    source: 'dhan',
    ...overrides,
  };
}

describe('SCENARIO 1 — live market renders the latest price', () => {
  it('shows the tick, its move and an up direction', () => {
    const row = toDisplayRow(
      quote({
        ltp: 24836.3,
        previousClose: 24700,
        change: 136.3,
        changePct: 0.55,
        priceSource: 'live',
        session: '2026-09-03',
        marketStatus: 'open',
      }),
    );

    expect(row.price).toBe('24,836.30');
    expect(row.changeText).toBe('+136.30');
    expect(row.changePctText).toBe('+0.55%');
    expect(row.direction).toBe('up');
    expect(row.atPreviousClose).toBe(false);
  });
});

describe('SCENARIO 2 — market closed renders the last valid price, not zero', () => {
  it('renders the carried-forward close and labels it as such', () => {
    const row = toDisplayRow(
      quote({
        ltp: 24851.05,
        previousClose: 24700,
        change: 151.05,
        changePct: 0.61,
        priceSource: 'previous-close',
        session: '2026-09-03',
        marketStatus: 'closed',
      }),
    );

    expect(row.price).toBe('24,851.05');
    expect(row.price).not.toBe('0.00');
    // The pill next to these cards says "Market closed". Without this flag the
    // number beside it read as a live quote.
    expect(row.atPreviousClose).toBe(true);
  });

  it('labels the session’s own last trade as stale once the market shuts', () => {
    // The price came from a real tick at 15:30, so `priceSource` is 'live' —
    // but it is 19:00 and the exchange is closed, so the number is not current.
    const row = toDisplayRow(
      quote({ ltp: 24851.05, previousClose: 24700, change: 151.05, changePct: 0.61, priceSource: 'live', marketStatus: 'closed' }),
    );
    expect(row.price).toBe('24,851.05');
    expect(row.atPreviousClose).toBe(true);
  });

  it('does not label an unknown price as being at the previous close', () => {
    // There is no price to describe the vintage of.
    expect(toDisplayRow(quote({ marketStatus: 'closed' })).atPreviousClose).toBe(false);
  });
});

describe('SCENARIO 3 — an unknown price renders as "—", never as 0.00', () => {
  it('is the em-dash for every unknown field', () => {
    const row = toDisplayRow(quote({}));

    expect(row.price).toBe(NO_VALUE);
    expect(row.changeText).toBe(NO_VALUE);
    expect(row.changePctText).toBe(NO_VALUE);
    // Not green, not red. Colouring an unknown move is a claim about it.
    expect(row.direction).toBe('neutral');
    expect(row.ltp).toBeNull();
  });

  it('shows a known price with an unknown move without inventing "+0.00"', () => {
    const row = toDisplayRow(quote({ ltp: 24851.05, priceSource: 'previous-close' }));
    expect(row.price).toBe('24,851.05');
    expect(row.changeText).toBe(NO_VALUE);
    expect(row.changePctText).toBe(NO_VALUE);
    expect(row.direction).toBe('neutral');
  });
});

describe('SCENARIO 5 — the next session’s price takes over', () => {
  it('renders the new price against the previous close', () => {
    const row = toDisplayRow(
      quote({
        ltp: 24880.2,
        previousClose: 24851.05,
        change: 29.15,
        changePct: 0.12,
        priceSource: 'live',
        session: '2026-09-04',
        marketStatus: 'open',
      }),
    );

    expect(row.price).toBe('24,880.20');
    expect(row.changeText).toBe('+29.15');
    expect(row.atPreviousClose).toBe(false);
  });
});

describe('SCENARIO 6 — the same projection for every instrument class', () => {
  it.each([
    ['NIFTY', 'Nifty 50', 24851.05, '24,851.05'],
    ['SENSEX', 'BSE Sensex', 81234.5, '81,234.50'],
    ['INDIAVIX', 'India VIX', 12.34, '12.34'],
    ['RELIANCE', 'Reliance Industries', 2954.1, '2,954.10'],
    ['NIFTYBEES', 'Nippon Nifty BeES', 271.55, '271.55'],
    ['GOLD', 'Gold', 71450, '71,450.00'],
  ])('%s renders its last valid price', (symbol, displayName, ltp, expected) => {
    const row = toDisplayRow(quote({ symbol, displayName, ltp, priceSource: 'previous-close' }));
    expect(row.price).toBe(expected);
    expect(row.symbol).toBe(symbol);
    expect(row.name).toBe(displayName);
  });

  it.each(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'INDIAVIX', 'RELIANCE', 'GOLD'])(
    '%s with no observed price renders "—", which is what the screenshot showed as 0.00',
    (symbol) => {
      expect(toDisplayRow(quote({ symbol })).price).toBe(NO_VALUE);
    },
  );
});

describe('the formatters refuse to turn absence into a number', () => {
  it('fmtPrice', () => {
    expect(fmtPrice(24851.05)).toBe('24,851.05');
    expect(fmtPrice(null)).toBe(NO_VALUE);
    expect(fmtPrice(undefined)).toBe(NO_VALUE);
    expect(fmtPrice(NaN)).toBe(NO_VALUE);
    // A genuine zero, should one ever be a real observation, is still shown —
    // these helpers report what they are given, they do not re-decide validity.
    // The zero-is-absent rule lives at the ingestion boundary, once.
    expect(fmtPrice(0)).toBe('0.00');
  });

  it('pctOrDash and changeOrDash distinguish "did not move" from "unknown"', () => {
    expect(pctOrDash(0)).toBe('0.00%');
    expect(pctOrDash(null)).toBe(NO_VALUE);
    expect(changeOrDash(0)).toBe('0.00');
    expect(changeOrDash(-96.2)).toBe('-96.20');
    expect(changeOrDash(null)).toBe(NO_VALUE);
  });
});

describe('directionOf', () => {
  it('never paints an unknown move', () => {
    expect(directionOf(1)).toBe('up');
    expect(directionOf(-1)).toBe('down');
    // `change >= 0` used to make every unknown quote green — a fabricated fact
    // rendered in the confident colour.
    expect(directionOf(0)).toBe('neutral');
    expect(directionOf(null)).toBe('neutral');
    expect(directionOf(undefined)).toBe('neutral');
  });
});
