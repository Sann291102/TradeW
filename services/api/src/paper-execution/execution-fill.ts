/**
 * How a paper fill's price was arrived at, recorded rather than assumed.
 *
 * ## Why this module exists at all
 *
 * `OrderService` already fills a BUY at the ask and a SELL at the bid. That is
 * the right model and this does not change it. What was missing is the RECORD:
 * an agent's fill at 121.35 is a number with no stated provenance, and six
 * weeks later nobody can say whether it crossed a real 0.10 spread or a
 * synthetic one the bridge invented because Dhan's quote-mode tick carried no
 * depth.
 *
 * That distinction is not academic. `MarketPriceService.getOptionPrice`
 * substitutes `ltp × 0.9995 / 1.0005` whenever the chain publishes bid = ask =
 * 0, which happens routinely after hours and on illiquid strikes. A paper P&L
 * computed against a 10-basis-point synthetic spread is systematically
 * optimistic against a real option book, and a backtest that does not know
 * which of the two it got will read as more accurate than it is.
 *
 * So this module produces a `PaperFillModel` that is stored on the intent and
 * shown in the journal. It states the reference prices, the spread, whether
 * that spread looks synthetic, the slippage crossing it costs, and — most
 * importantly — the list of things it does NOT model.
 *
 * ## It does not change any price
 *
 * `fillPrice` here is the price `OrderService` will use, recomputed from the
 * same inputs so the record and the order agree. This module is deliberately
 * incapable of moving a fill: if it disagreed with the OMS the OMS would win,
 * and the record would be wrong in a way nothing would catch. The
 * `matchesOms` field exists to make that agreement checkable rather than
 * assumed.
 */

export type FillSide = 'BUY' | 'SELL';

export interface FillModelInput {
  side: FillSide;
  /** Last traded price of the contract. */
  ltp: number;
  bid: number;
  ask: number;
  quantity: number;
  /** Age of the underlying feed at the moment of the read, when known. */
  quoteAgeMs: number | null;
  marketOpen: boolean;
  /** MARKET is the only type the agent places today; recorded regardless. */
  orderType: string;
}

export interface PaperFillModel {
  model: 'cross-the-spread';
  side: FillSide;
  /** The price the paper OMS will fill at: ask for a BUY, bid for a SELL. */
  fillPrice: number;
  referenceLtp: number;
  bid: number;
  ask: number;
  spread: number;
  spreadPct: number;
  /**
   * `quoted` when the venue published real depth; `synthetic-from-ltp` when
   * the spread is exactly the ±5bp the bridge fabricates around LTP for a
   * tick that carried none.
   */
  spreadSource: 'quoted' | 'synthetic-from-ltp';
  /** fillPrice − ltp. Positive is a cost on a BUY. */
  slippage: number;
  slippagePct: number;
  quantity: number;
  notional: number;
  quoteAgeMs: number | null;
  marketOpen: boolean;
  orderType: string;
  /** What this model assumes, in words, including everything it ignores. */
  assumptions: string[];
}

/**
 * The bridge's synthetic half-spread, as a fraction of LTP.
 *
 * Mirrors `market-price.service.ts`: `bid = ltp * 0.9995`, `ask = ltp * 1.0005`
 * whenever the quoted side is zero. Detected rather than passed in, because
 * the API's own price service has already collapsed the two cases into one
 * shape by the time this runs — the numbers are the only evidence left.
 */
const SYNTHETIC_HALF_SPREAD = 0.0005;
/**
 * Relative tolerance for recognising that fabricated width.
 *
 * RELATIVE, and compared against the UNROUNDED spread. Both details matter:
 * an absolute tolerance fails on cheap contracts (a ₹18 option's synthetic
 * spread is 0.018, so any fixed epsilon is either useless there or enormous on
 * a ₹990 one), and comparing the 4-decimal `spread` field against an unrounded
 * expectation fails whenever the rounding moves the last digit — which it does
 * for most premiums. 1% of the expected width is far tighter than any real
 * book spread, which runs 10–100× wider than the fabricated one.
 */
const SYNTHETIC_TOLERANCE_PCT = 0.01;

export function modelPaperFill(input: FillModelInput): PaperFillModel {
  const { side, ltp, bid, ask, quantity, quoteAgeMs, marketOpen, orderType } = input;

  // The same expression `OrderService.placeOrder` uses for a MARKET order.
  const fillPrice = side === 'BUY' ? ask : bid;
  const rawSpread = ask - bid;
  const spread = round4(rawSpread);
  const spreadPct = ltp > 0 ? round4((spread / ltp) * 100) : 0;

  const expectedSyntheticSpread = ltp * SYNTHETIC_HALF_SPREAD * 2;
  const spreadSource: PaperFillModel['spreadSource'] =
    ltp > 0 &&
    expectedSyntheticSpread > 0 &&
    Math.abs(rawSpread - expectedSyntheticSpread) <= expectedSyntheticSpread * SYNTHETIC_TOLERANCE_PCT
      ? 'synthetic-from-ltp'
      : 'quoted';

  const slippage = round4(fillPrice - ltp);
  const slippagePct = ltp > 0 ? round4((slippage / ltp) * 100) : 0;

  const assumptions: string[] = [
    `${side} fills at the ${side === 'BUY' ? 'ask' : 'bid'} — the paper OMS crosses the spread, it does not fill at the mid.`,
    'Filled in full at one price. The paper engine models no partial fills, so a quantity larger than the displayed size still fills whole.',
    'No market impact: the order is assumed small relative to resting liquidity, which is not checked against depth because the feed publishes none.',
    'No latency: the fill is priced at the quote read moments earlier, with no allowance for the time between decision and execution.',
  ];

  if (spreadSource === 'synthetic-from-ltp') {
    assumptions.push(
      `The bid/ask are SYNTHETIC — exactly LTP ±${(SYNTHETIC_HALF_SPREAD * 100).toFixed(2)}%, which is what the price service ` +
        'substitutes when the tick carries no depth. The real spread is unknown and is almost certainly wider, so the ' +
        `${Math.abs(slippage).toFixed(2)}-point slippage modelled here is a FLOOR, not an estimate.`,
    );
  } else {
    assumptions.push(
      `Spread of ${spread.toFixed(2)} (${spreadPct.toFixed(3)}% of LTP) came from the published book rather than being fabricated around LTP.`,
    );
  }

  if (!marketOpen) {
    assumptions.push('The session was NOT open at the time of this read, so the quote is a last-known price rather than a live one.');
  }
  if (quoteAgeMs != null) {
    assumptions.push(`The underlying feed had ticked ${quoteAgeMs} ms before this read.`);
  } else {
    assumptions.push('Feed age was unavailable for this read, so quote staleness could not be measured.');
  }

  return {
    model: 'cross-the-spread',
    side,
    fillPrice,
    referenceLtp: ltp,
    bid,
    ask,
    spread,
    spreadPct,
    spreadSource,
    slippage,
    slippagePct,
    quantity,
    notional: round2(fillPrice * quantity),
    quoteAgeMs,
    marketOpen,
    orderType,
    assumptions,
  };
}

/**
 * Did the OMS fill where this model said it would?
 *
 * Recorded on the intent after the order comes back. A mismatch is not
 * necessarily a bug — a resting LIMIT order legitimately fills elsewhere, and
 * the matching engine prices its own fills — but an unexplained mismatch on a
 * MARKET order means the model and the engine have drifted, and that is worth
 * seeing in a journal rather than discovering by reconciling P&L by hand.
 */
export function reconcileFill(model: PaperFillModel, actualFillPrice: number | null): {
  matchesOms: boolean;
  actualFillPrice: number | null;
  difference: number | null;
  note: string;
} {
  if (actualFillPrice == null) {
    return {
      matchesOms: false,
      actualFillPrice: null,
      difference: null,
      note: 'The order did not fill immediately, so there is no fill price to compare the model against.',
    };
  }
  const difference = round4(actualFillPrice - model.fillPrice);
  const matches = Math.abs(difference) < 0.005;
  return {
    matchesOms: matches,
    actualFillPrice,
    difference,
    note: matches
      ? `The OMS filled at ${actualFillPrice.toFixed(2)}, as modelled.`
      : `The OMS filled at ${actualFillPrice.toFixed(2)}, ${difference > 0 ? 'above' : 'below'} the modelled ${model.fillPrice.toFixed(2)} by ${Math.abs(difference).toFixed(2)}.`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
