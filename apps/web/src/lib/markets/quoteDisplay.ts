import type { DhanLiveQuote, DhanPriceSource } from '@/lib/dhanLiveFeed';
import { NO_VALUE, changeOrDash, fmtPrice, pctOrDash } from '@/lib/format';

/**
 * The last leg of the market-data path: a bridge quote -> what a card renders.
 *
 * ── WHY THIS IS A MODULE AND NOT INLINE JSX ────────────────────────────────
 *
 * "Market closed shows 0.00" was fixed in the UI several times before, and it
 * kept coming back, because each fix was a `?? 0` or a `|| previousPrice` at
 * one more call site. There were eight surfaces mapping the same feed into the
 * same three strings, so a fix at one of them was never a fix.
 *
 * The decision now lives here, once, and it is pure — no React, no fetch, no
 * clock — so it is asserted by tests rather than eyeballed on a dashboard at
 * 16:00. The components below it render whatever strings this returns.
 *
 * The rule it implements: the bridge has already resolved the price down to
 * either "the last valid one" or "never observed". So there is nothing left to
 * fall back to here. A number is shown as a number; `null` is shown as "—".
 * Zero is not a fallback, and this file must never grow one.
 */
export interface QuoteDisplayRow {
  symbol: string;
  name: string;
  /** The numeric price, for charts and sorting. Null when unknown. */
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  /** Preformatted price, "—" when unknown. */
  price: string;
  /** Preformatted signed change, "—" when uncomputable. */
  changeText: string;
  /** Preformatted signed percent, "—" when uncomputable. */
  changePctText: string;
  /** Direction for colour. 'neutral' when the move is unknown, so an unknown
   *  quote is never painted green or red — the colour would be a claim. */
  direction: 'up' | 'down' | 'neutral';
  /**
   * True when this price is a carried-forward last valid price rather than a
   * live tick, so a surface can label it "at previous close".
   *
   * Two ways to be carried forward, and both count. The obvious one is a price
   * that came from a previous close or a historical bar. The one easy to miss
   * is a price that WAS a live tick — the session's last trade — and has simply
   * stopped being current because the exchange shut. Judging staleness by
   * `priceSource` alone would label the 15:30 close as live for the whole
   * evening, which is the same claim the 0.00 cards were making, just with a
   * believable number on it.
   */
  atPreviousClose: boolean;
  priceSource: DhanPriceSource | null;
}

export function toDisplayRow(quote: DhanLiveQuote): QuoteDisplayRow {
  return {
    symbol: quote.symbol,
    name: quote.displayName,
    ltp: quote.ltp,
    change: quote.change,
    changePct: quote.changePct,
    price: fmtPrice(quote.ltp),
    changeText: changeOrDash(quote.change),
    changePctText: pctOrDash(quote.changePct),
    direction: directionOf(quote.change),
    atPreviousClose:
      quote.ltp !== null && (quote.marketStatus === 'closed' || quote.priceSource !== 'live'),
    priceSource: quote.priceSource,
  };
}

/** Colour direction. An unknown move is `neutral`: painting it green because
 *  `0 >= 0` is how "0.00" came to be shown in the up colour on a closed
 *  market — a fabricated fact rendered as a confident one. */
export function directionOf(change: number | null | undefined): 'up' | 'down' | 'neutral' {
  if (typeof change !== 'number' || !Number.isFinite(change)) return 'neutral';
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'neutral';
}

/** Tailwind text colour token for a direction, matching the app's up/down/muted
 *  scale. Kept here so every surface colours an unknown quote the same way. */
export function directionClass(direction: 'up' | 'down' | 'neutral'): string {
  return direction === 'up' ? 'text-up' : direction === 'down' ? 'text-down' : 'text-muted';
}

export { NO_VALUE };
