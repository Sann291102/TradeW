import { describe, expect, it } from 'vitest';

import { FEED_CODE, parseFrame } from '../providers/dhan/dhan-binary-parser';
import { LastPriceStore } from './last-price-store';
import { isValidPrice, istTradingDay, mergeObservation, toQuoteView } from './last-price';

/**
 * THE MARKET-CLOSED PRICE INVARIANT, END TO END.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Reported with a screenshot: with the market shut, the dashboard rendered
 * NIFTY 50, NIFTY BANK, FIN NIFTY, BSE SENSEX and INDIA VIX all at "0.00", and
 * the hero chart collapsed to zero with them. The exchange had not moved to
 * nothing; the platform had lost the last price it observed and printed the
 * absence as a number.
 *
 * Two independent origins, reproduced below as `it` blocks that would each
 * have failed before this change:
 *
 *   1. the bridge seeded every tracked instrument with `ltp: 0` at boot and
 *      published those rows as genuine broker quotes;
 *   2. Dhan encodes "no value in this packet" as 0.0, and outside session
 *      hours a Quote packet is all zeros — which the parser read as real
 *      prices and the bridge used to REPLACE the whole stored quote, wiping
 *      the previous close delivered seconds earlier on the PREV_CLOSE packet.
 *
 * ── WHAT THESE TESTS DRIVE ────────────────────────────────────────────────
 *
 * Real bytes in the documented Dhan wire layouts, through the real parser,
 * into the real store, out through the real projection — the same four pieces
 * the running bridge composes. Nothing here is a stand-in, so a regression
 * anywhere along that path fails here rather than on a dashboard at 16:00.
 *
 * The six scenarios the fix was required to cover are marked SCENARIO 1..6.
 */

// ---------------------------------------------------------------------------
// Dhan v2 Live Market Feed packet builders (layouts per dhan-binary-parser.ts)
// ---------------------------------------------------------------------------

const IDX_SEGMENT = 0;

function header(buf: Buffer, code: number, len: number, securityId: number): void {
  buf.writeUInt8(code, 0);
  buf.writeInt16LE(len, 1);
  buf.writeUInt8(IDX_SEGMENT, 3);
  buf.writeInt32LE(securityId, 4);
}

/** LTT is seconds-from-epoch read as IST wall clock (see `tradeTime`). */
function ltt(at: Date): number {
  return Math.floor((at.getTime() + (5 * 60 + 30) * 60_000) / 1000);
}

/** Code 6 — what Dhan pushes for every instrument on subscribe. */
function prevClosePacket(securityId: number, previousClose: number): Buffer {
  const b = Buffer.alloc(16);
  header(b, FEED_CODE.PREV_CLOSE, 16, securityId);
  b.writeFloatLE(previousClose, 8);
  b.writeInt32LE(0, 12);
  return b;
}

/** Code 2 — ticker: LTP and trade time only. */
function tickerPacket(securityId: number, price: number, at: Date): Buffer {
  const b = Buffer.alloc(16);
  header(b, FEED_CODE.TICKER, 16, securityId);
  b.writeFloatLE(price, 8);
  b.writeInt32LE(ltt(at), 12);
  return b;
}

/** Code 4 — quote: LTP + OHLC + volume. */
function quotePacket(
  securityId: number,
  q: { ltp: number; open: number; high: number; low: number; close: number; volume: number },
  at: Date,
): Buffer {
  const b = Buffer.alloc(50);
  header(b, FEED_CODE.QUOTE, 50, securityId);
  b.writeFloatLE(q.ltp, 8);
  b.writeInt16LE(0, 12);
  b.writeInt32LE(ltt(at), 14);
  b.writeFloatLE(q.ltp, 18);
  b.writeInt32LE(q.volume, 22);
  b.writeInt32LE(0, 26);
  b.writeInt32LE(0, 30);
  b.writeFloatLE(q.open, 34);
  b.writeFloatLE(q.close, 38);
  b.writeFloatLE(q.high, 42);
  b.writeFloatLE(q.low, 46);
  return b;
}

/** The bridge's own tick handler, verbatim in shape: parse a frame and fold
 *  every tick it carries into the store under `key`. */
function feed(store: LastPriceStore, key: string, frame: Buffer): void {
  for (const packet of parseFrame(frame)) {
    if (packet.kind !== 'tick') continue;
    const t = packet.tick;
    store.observe(key, {
      ltp: t.ltp,
      previousClose: t.previousClose,
      open: t.open,
      high: t.high,
      low: t.low,
      close: t.close,
      bid: t.bid,
      ask: t.ask,
      volume: t.volume,
      at: t.at,
    });
  }
}

const NIFTY_ID = 13;
const RELIANCE_ID = 2885;

const SESSION_OPEN = new Date('2026-09-03T03:45:00Z'); // 09:15 IST
const MIDDAY = new Date('2026-09-03T06:30:00Z'); // 12:00 IST
const AT_CLOSE = new Date('2026-09-03T10:00:00Z'); // 15:30 IST
const AFTER_CLOSE = new Date('2026-09-03T13:30:00Z'); // 19:00 IST — the screenshot
const NEXT_OPEN = new Date('2026-09-04T03:45:00Z'); // 09:15 IST, next session

// ---------------------------------------------------------------------------

describe('isValidPrice — zero is absence, not a price', () => {
  it('accepts a real traded price', () => {
    expect(isValidPrice(24836.3)).toBe(true);
    expect(isValidPrice(0.05)).toBe(true);
  });

  it('rejects every shape of "no value"', () => {
    // Zero is what Dhan sends for a field it is not carrying. Treating it as a
    // price is the whole defect, so it is rejected first and by name.
    expect(isValidPrice(0)).toBe(false);
    expect(isValidPrice(null)).toBe(false);
    expect(isValidPrice(undefined)).toBe(false);
    expect(isValidPrice(NaN)).toBe(false);
    expect(isValidPrice(Infinity)).toBe(false);
    // Negative prices are not a thing on any exchange this platform quotes.
    expect(isValidPrice(-12)).toBe(false);
  });
});

describe('the Dhan parser reads a wire zero as absent', () => {
  it('emits undefined, not 0, for an out-of-session quote packet', () => {
    // This is the packet the exchange actually sends after 15:30: the fields
    // exist in the layout but carry nothing.
    const [packet] = parseFrame(
      quotePacket(NIFTY_ID, { ltp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }, AFTER_CLOSE),
    );
    expect(packet.kind).toBe('tick');
    if (packet.kind !== 'tick') return;
    expect(packet.tick.ltp).toBeUndefined();
    expect(packet.tick.open).toBeUndefined();
    expect(packet.tick.high).toBeUndefined();
    expect(packet.tick.low).toBeUndefined();
    expect(packet.tick.close).toBeUndefined();
  });

  it('still reads a real price as a price', () => {
    const [packet] = parseFrame(tickerPacket(NIFTY_ID, 24836.3, MIDDAY));
    expect(packet.kind).toBe('tick');
    if (packet.kind !== 'tick') return;
    expect(packet.tick.ltp).toBe(24836.3);
  });

  it('keeps a genuine zero count, which is a fact', () => {
    // Volume 0 means "nothing has traded", which is information. Only PRICES
    // get the zero-is-absent rule.
    const [packet] = parseFrame(
      quotePacket(NIFTY_ID, { ltp: 24836.3, open: 24800, high: 24900, low: 24780, close: 0, volume: 0 }, MIDDAY),
    );
    if (packet.kind !== 'tick') throw new Error('expected a tick');
    expect(packet.tick.volume).toBe(0);
  });
});

describe('SCENARIO 1 — live market shows the latest price', () => {
  it('takes each newer valid tick', () => {
    const store = new LastPriceStore();
    feed(store, 'index:NIFTY', prevClosePacket(NIFTY_ID, 24700));
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24810.5, SESSION_OPEN));
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24836.3, MIDDAY));

    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24836.3);
    expect(view.previousClose).toBe(24700);
    expect(view.change).toBe(136.3);
    expect(view.changePct).toBe(0.55);
    expect(view.source).toBe('live');
  });
});

describe('SCENARIO 2 — the market closes and the last valid price stays', () => {
  it('holds the closing price through hours of silence', () => {
    const store = new LastPriceStore();
    feed(store, 'index:NIFTY', prevClosePacket(NIFTY_ID, 24700));
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24836.3, MIDDAY));
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24851.05, AT_CLOSE));

    // 19:00 IST. Nothing arrives, because the exchange is shut.
    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24851.05);
    expect(view.ltp).not.toBe(0);
    expect(view.change).toBe(151.05);
  });
});

describe('SCENARIO 3 — a 0/null/undefined update after close changes nothing', () => {
  it('survives the all-zero quote packet that produced the screenshot', () => {
    const store = new LastPriceStore();
    feed(store, 'index:NIFTY', prevClosePacket(NIFTY_ID, 24700));
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24851.05, AT_CLOSE));

    // The exact sequence from the bug: an out-of-session packet whose every
    // price field is zero. Before the fix this replaced the stored quote and
    // the card read 0.00.
    feed(
      store,
      'index:NIFTY',
      quotePacket(NIFTY_ID, { ltp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }, AFTER_CLOSE),
    );

    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24851.05);
    expect(view.previousClose).toBe(24700);
  });

  it('ignores an explicit null and an explicit undefined alike', () => {
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24851.05, previousClose: 24700, at: AT_CLOSE });
    store.observe('index:NIFTY', { ltp: null, previousClose: null, at: AFTER_CLOSE });
    store.observe('index:NIFTY', { ltp: undefined, at: AFTER_CLOSE });
    store.observe('index:NIFTY', { ltp: 0, at: AFTER_CLOSE });

    expect(store.get('index:NIFTY').ltp).toBe(24851.05);
    expect(store.get('index:NIFTY').previousClose).toBe(24700);
  });

  it('does not let a zeroed packet erase the intraday OHLC either', () => {
    const store = new LastPriceStore();
    feed(
      store,
      'index:NIFTY',
      quotePacket(NIFTY_ID, { ltp: 24851.05, open: 24710, high: 24880, low: 24690, close: 0, volume: 120 }, AT_CLOSE),
    );
    feed(
      store,
      'index:NIFTY',
      quotePacket(NIFTY_ID, { ltp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }, AFTER_CLOSE),
    );

    const quote = store.get('index:NIFTY');
    expect(quote.open).toBe(24710);
    expect(quote.high).toBe(24880);
    expect(quote.low).toBe(24690);
    expect(quote.volume).toBe(120);
  });

  it('shows the previous close when the session produced no trade at all', () => {
    // A cold bridge started after the close: the only thing the exchange sends
    // is the subscribe-time previous close. That IS the last valid price.
    const store = new LastPriceStore();
    feed(store, 'index:NIFTY', prevClosePacket(NIFTY_ID, 24851.05));

    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24851.05);
    expect(view.source).toBe('previous-close');
  });
});

describe('SCENARIO 4 — a restart after the close recovers the last valid price', () => {
  it('round-trips through serialize/hydrate', () => {
    const before = new LastPriceStore();
    feed(before, 'index:NIFTY', prevClosePacket(NIFTY_ID, 24700));
    feed(before, 'index:NIFTY', tickerPacket(NIFTY_ID, 24851.05, AT_CLOSE));
    feed(before, 'stock:RELIANCE', prevClosePacket(RELIANCE_ID, 2903.4));
    feed(before, 'stock:RELIANCE', tickerPacket(RELIANCE_ID, 2954.1, AT_CLOSE));

    // The process dies. Everything it knew is in this document and nowhere else.
    const document = JSON.parse(JSON.stringify(before.serialize()));

    const after = new LastPriceStore();
    expect(toQuoteView(after.get('index:NIFTY')).ltp).toBeNull(); // genuinely cold
    expect(after.hydrate(document)).toBe(2);

    expect(toQuoteView(after.get('index:NIFTY')).ltp).toBe(24851.05);
    expect(toQuoteView(after.get('index:NIFTY')).previousClose).toBe(24700);
    expect(toQuoteView(after.get('stock:RELIANCE')).ltp).toBe(2954.1);
    expect(toQuoteView(after.get('stock:RELIANCE')).change).toBe(50.7);
  });

  it('recovers nothing from a document that claims a price of zero', () => {
    // A hand-edited or corrupted file must not be able to reintroduce the
    // defect through the back door: hydration goes through the same validity
    // gate as a live tick.
    const store = new LastPriceStore();
    store.hydrate({
      version: 1,
      savedAt: AFTER_CLOSE.toISOString(),
      quotes: { 'index:NIFTY': { ltp: 0, previousClose: 0, at: AFTER_CLOSE.toISOString() } },
    });
    expect(toQuoteView(store.get('index:NIFTY')).ltp).toBeNull();
  });

  it('ignores a document written by a different schema version', () => {
    const store = new LastPriceStore();
    expect(store.hydrate({ version: 99, savedAt: AFTER_CLOSE.toISOString(), quotes: {} })).toBe(0);
    expect(store.hydrate(null)).toBe(0);
    expect(store.hydrate('not a document')).toBe(0);
  });

  it('lets a live tick that beat the disk read win', () => {
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24999, at: NEXT_OPEN }); // websocket was first
    store.hydrate({
      version: 1,
      savedAt: AT_CLOSE.toISOString(),
      quotes: { 'index:NIFTY': { ltp: 24851.05, session: '2026-09-03', at: AT_CLOSE.toISOString() } },
    });
    expect(store.get('index:NIFTY').ltp).toBe(24999);
  });
});

describe('SCENARIO 5 — the next session replaces the previous close', () => {
  it('promotes yesterday’s last price to previousClose on the first new tick', () => {
    const store = new LastPriceStore();
    feed(store, 'index:NIFTY', prevClosePacket(NIFTY_ID, 24700));
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24851.05, AT_CLOSE));
    expect(store.get('index:NIFTY').session).toBe('2026-09-03');

    // 09:15 the next morning: the first real trade of the new session.
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24880.2, NEXT_OPEN));

    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24880.2);
    expect(view.previousClose).toBe(24851.05);
    expect(view.change).toBe(29.15);
    expect(view.session).toBe('2026-09-04');
    expect(view.source).toBe('live');
  });

  it('clears the previous session’s intraday extremes rather than carrying them', () => {
    const store = new LastPriceStore();
    feed(
      store,
      'index:NIFTY',
      quotePacket(NIFTY_ID, { ltp: 24851.05, open: 24710, high: 24880, low: 24690, close: 0, volume: 900 }, AT_CLOSE),
    );
    feed(store, 'index:NIFTY', tickerPacket(NIFTY_ID, 24860, NEXT_OPEN));

    const quote = store.get('index:NIFTY');
    // Yesterday's 24,880 high shown against today's price would be a false
    // statement about today's session.
    expect(quote.high).toBeNull();
    expect(quote.low).toBeNull();
    expect(quote.open).toBeNull();
    expect(quote.volume).toBeNull();
    expect(quote.ltp).toBe(24860);
  });

  it('lets the exchange’s own previous close override the promoted one', () => {
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24851.05, at: AT_CLOSE });
    // Dhan re-sends PREV_CLOSE on the new session's subscribe; it is settled
    // and authoritative, so it wins over our promoted last-traded value.
    store.observe('index:NIFTY', { ltp: 24880.2, previousClose: 24850, at: NEXT_OPEN });
    expect(store.get('index:NIFTY').previousClose).toBe(24850);
  });

  it('does not roll the session on an empty out-of-hours packet', () => {
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24851.05, previousClose: 24700, at: AT_CLOSE });
    // A priceless packet stamped the next day must not retire the close into
    // previousClose and leave the quote with nothing in its place.
    store.observe('index:NIFTY', { ltp: 0, at: NEXT_OPEN });
    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24851.05);
    expect(view.previousClose).toBe(24700);
  });
});

describe('SCENARIO 6 — the same rules for stocks, ETFs, commodities and options', () => {
  it.each([
    ['index:NIFTY', NIFTY_ID, 24851.05, 24700],
    ['stock:RELIANCE', RELIANCE_ID, 2954.1, 2903.4],
    ['etf:NIFTYBEES', 4321, 271.55, 269.8],
    ['commodity:GOLD', 9876, 71450, 71100],
  ])('holds the last valid price for %s after the close', (key, id, close, prevClose) => {
    const store = new LastPriceStore();
    feed(store, key, prevClosePacket(id, prevClose));
    feed(store, key, tickerPacket(id, close, AT_CLOSE));
    feed(store, key, quotePacket(id, { ltp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }, AFTER_CLOSE));

    const view = toQuoteView(store.get(key));
    expect(view.ltp).toBe(close);
    expect(view.previousClose).toBe(prevClose);
  });

  it('is keyed per instrument, so one zeroed feed cannot affect another', () => {
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24851.05, at: AT_CLOSE });
    store.observe('stock:RELIANCE', { ltp: 2954.1, at: AT_CLOSE });
    store.observe('index:NIFTY', { ltp: 0, at: AFTER_CLOSE });

    expect(store.get('index:NIFTY').ltp).toBe(24851.05);
    expect(store.get('stock:RELIANCE').ltp).toBe(2954.1);
  });
});

describe('a never-observed instrument reports absence, not zero', () => {
  it('is null all the way through the projection', () => {
    const view = toQuoteView(new LastPriceStore().get('index:NEVERSEEN'));
    expect(view.ltp).toBeNull();
    expect(view.change).toBeNull();
    expect(view.changePct).toBeNull();
    expect(view.source).toBeNull();
  });

  it('reports change as null, not 0, when only the price is known', () => {
    // "+0.00 (0.00%)" beside a real price asserts the market did not move.
    // Unknown and unmoved are different claims.
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24851.05, at: AT_CLOSE });
    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24851.05);
    expect(view.change).toBeNull();
    expect(view.changePct).toBeNull();
  });
});

describe('backfill fills gaps without overwriting observations', () => {
  it('supplies a price when nothing is known', () => {
    const store = new LastPriceStore();
    store.backfill('index:NIFTY', { ltp: 24851.05, previousClose: 24700, at: AT_CLOSE });
    const view = toQuoteView(store.get('index:NIFTY'));
    expect(view.ltp).toBe(24851.05);
    expect(view.source).toBe('last-session-bar');
  });

  it('cannot drag a live price back to a historical bar', () => {
    // The boot-time bar fetch is async and regularly lands after the websocket
    // has already delivered a real tick.
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24880.2, at: NEXT_OPEN });
    store.backfill('index:NIFTY', { ltp: 24851.05, at: AT_CLOSE });
    expect(store.get('index:NIFTY').ltp).toBe(24880.2);
  });
});

describe('serialize keeps the file to what is worth recovering', () => {
  it('omits instruments with no price at all', () => {
    const store = new LastPriceStore();
    store.observe('index:NIFTY', { ltp: 24851.05, at: AT_CLOSE });
    store.observe('stock:NEVERTRADED', { ltp: 0, at: AT_CLOSE });

    const document = store.serialize();
    expect(Object.keys(document.quotes)).toEqual(['index:NIFTY']);
  });
});

describe('istTradingDay', () => {
  it('puts an IST session on its own calendar day', () => {
    expect(istTradingDay(SESSION_OPEN)).toBe('2026-09-03'); // 09:15 IST
    expect(istTradingDay(AT_CLOSE)).toBe('2026-09-03'); // 15:30 IST
    // 19:00 IST is 13:30Z the same day — a naive UTC date agrees here, but
    // 23:00 IST is 17:30Z and would not, which is the case that matters.
    expect(istTradingDay(new Date('2026-09-03T17:30:00Z'))).toBe('2026-09-03');
    expect(istTradingDay(new Date('2026-09-03T18:31:00Z'))).toBe('2026-09-04');
  });
});

describe('mergeObservation is pure', () => {
  it('does not mutate the state it was given', () => {
    const previous = mergeObservation(null, { ltp: 24851.05, previousClose: 24700, at: AT_CLOSE });
    const snapshot = { ...previous };
    mergeObservation(previous, { ltp: 24880.2, at: NEXT_OPEN });
    expect(previous).toEqual(snapshot);
  });
});
