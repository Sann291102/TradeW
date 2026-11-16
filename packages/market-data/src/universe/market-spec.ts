/**
 * Tradable market specs — the spine of the multi-market experiment.
 *
 * ## What this is for
 *
 * The experiment asks one question: *which strategies work in which markets?*
 * Answering it needs the same strategy engine to reach three very different
 * instruments — an NSE index option, a Binance spot pair, an MCX futures
 * contract — without the strategy learning which one it is looking at.
 *
 * The pipeline the brief asks for is
 *
 *     Market → Instrument → Data Adapter → Strategy → Signal
 *            → Execution Intent → Execution Adapter → Position/P&L
 *
 * This module owns the first two boxes and declares which adapters the last
 * two must use. It is deliberately pure data: no fetching, no Prisma, no Nest.
 *
 * ## Why the `market` field is coarser than the venue
 *
 * `ExperimentMarket` has three members where `MarketVenue` has five. That is
 * not sloppiness — they answer different questions. The venue decides *when
 * trading is possible and in what currency*; the experiment market decides
 * *which row of the comparison table a result belongs to*. NSE and BSE are two
 * venues and one experiment ("Indian markets"); MCX is one venue and its own
 * experiment, because gold is the thing being tested, not India-at-large.
 *
 * ## The rule this module exists to enforce
 *
 * A strategy never reads any of these fields. Everything here is consumed by
 * the layers on either side of the strategy — the data adapter that feeds it
 * bars, and the execution adapter that turns its signal into an order. That
 * separation is what stops "works on BTC" from meaning "we wrote BTC-specific
 * strategy code".
 */

import type { MarketVenue } from '../calendar/venue-session';

/**
 * The unit of the cross-market comparison — one row-group in
 *
 *   | Market | Strategy | Trades | Win rate | P&L | Drawdown | ... |
 *
 * Three, because three is what is actually being tested. Adding USA or FOREX
 * here is a deliberate act that also commits to a data and execution path for
 * them; both are currently display-only (`chartSurface: 'embed'`), so listing
 * them would promise an experiment that cannot run.
 */
export const EXPERIMENT_MARKETS = ['INDIA', 'CRYPTO', 'GOLD'] as const;
export type ExperimentMarket = (typeof EXPERIMENT_MARKETS)[number];

/**
 * What the strategy's directional read gets expressed AS.
 *
 * This is the field that makes the option path one case rather than the only
 * case. Today's execution loop hard-codes `long-option`: it selects a strike
 * and an expiry, and `ExecutionIntent` requires both. Naming the style makes
 * the alternative representable.
 *
 *  - `long-option` — buy a CE for bullish, a PE for bearish. Directional
 *    exposure via premium; the traded instrument is NOT the analysed one, which
 *    is why trailing stops are measured in premium points rather than index
 *    points.
 *  - `spot` — buy the asset itself. Long-only (no borrow, no short), full
 *    notional paid, and the analysed instrument IS the traded one.
 *  - `futures` — buy or sell the contract. The analysed instrument is the
 *    traded one, but sizing is in whole lots and a contract has an expiry.
 */
export type ExecutionStyle = 'long-option' | 'spot' | 'futures';

/** What kind of thing is actually held after a fill. */
export type InstrumentKind = 'index' | 'equity' | 'index-option' | 'futures' | 'spot-crypto';

export interface TradableSpec {
  /** Canonical symbol, upper-case. The key everything else joins on. */
  symbol: string;
  displayName: string;
  /** Which row of the comparison table results land in. */
  market: ExperimentMarket;
  /** Which session/calendar/day-boundary applies. See `venue-session.ts`. */
  venue: MarketVenue;
  kind: InstrumentKind;
  executionStyle: ExecutionStyle;

  /**
   * The currency the venue quotes in — never the account's, never converted.
   *
   * Load-bearing for the comparison table: INR and USD P&L cannot be summed,
   * and there is no FX conversion anywhere in the paper-wallet path. See
   * `currency-policy.ts` for the standing rule this follows.
   */
  quoteCurrency: 'INR' | 'USD';

  /** Which backend serves ticks and bars. */
  quoteSource: 'dhan' | 'binance';
  candleSource: 'dhan' | 'binance';

  /**
   * Whether size may be fractional.
   *
   * The single most consequential field here. `Order.quantity` is an `Int` and
   * every price column is `Decimal(12,2)`, so the rupee OMS cannot hold 0.004
   * BTC — the smallest representable crypto order there is one whole coin. A
   * `true` here means the instrument MUST route to a decimal-precision order
   * table (`CryptoOrder`, `Decimal(28,8)`), never to `Order`.
   */
  fractionalQuantity: boolean;

  /**
   * Contract multiplier for whole-lot instruments, or null when fractional.
   *
   * MCX GOLD is 100 g per lot; GOLDM is 10 g. Not a cosmetic difference: at
   * roughly ₹1,00,000 per 10 g, one GOLD lot is a ~₹10 lakh notional against a
   * ₹10 lakh default paper wallet, so a single position would commit the whole
   * account and `capitalAllocationPct` would refuse every trade. Recorded so
   * the sizing layer can say that out loud instead of silently never trading.
   */
  lotSize: number | null;

  /** Can an order be placed at all, or is this display/analysis only. */
  tradeable: boolean;
  /** Spoken/typed forms, for the assistant and the command palette. */
  aliases: string[];
}

/**
 * The instruments the experiment actually runs on.
 *
 * Deliberately SMALL. This is a controlled experiment: one instrument per
 * market, so a difference in results is attributable to the market rather than
 * to which of twelve crypto pairs happened to trend. Widening it is a
 * deliberate act, not a default.
 */
const SPECS: readonly TradableSpec[] = [
  // ---- India — NSE index options on the NIFTY underlying -----------------
  //
  // The existing, working path. `symbol` is the UNDERLYING; the traded
  // instrument is a CE/PE contract the execution adapter selects at decision
  // time. That indirection is exactly what `executionStyle: 'long-option'`
  // names, and it is why `ExecutionIntent` carries a strike and an expiry.
  {
    symbol: 'NIFTY',
    displayName: 'NIFTY 50',
    market: 'INDIA',
    venue: 'NSE',
    kind: 'index',
    executionStyle: 'long-option',
    quoteCurrency: 'INR',
    quoteSource: 'dhan',
    candleSource: 'dhan',
    fractionalQuantity: false,
    lotSize: null, // resolved per-contract from the scrip master, not fixed here
    tradeable: true,
    aliases: ['nifty', 'nifty 50', 'nifty50'],
  },
  {
    symbol: 'BANKNIFTY',
    displayName: 'NIFTY Bank',
    market: 'INDIA',
    venue: 'NSE',
    kind: 'index',
    executionStyle: 'long-option',
    quoteCurrency: 'INR',
    quoteSource: 'dhan',
    candleSource: 'dhan',
    fractionalQuantity: false,
    lotSize: null,
    tradeable: true,
    aliases: ['bank nifty', 'banknifty', 'nifty bank'],
  },

  {
    symbol: 'SENSEX',
    displayName: 'BSE SENSEX',
    market: 'INDIA',
    venue: 'BSE',
    kind: 'index',
    executionStyle: 'long-option',
    quoteCurrency: 'INR',
    quoteSource: 'dhan',
    candleSource: 'dhan',
    fractionalQuantity: false,
    // Resolved per-contract from the scrip master like the NSE indices, not
    // fixed here — BSE has changed the SENSEX lot more than once, and a
    // hardcoded number is a silently wrong quantity the day it changes.
    lotSize: null,
    // Verified against the running bridge on 2026-09-10 before this was
    // flipped on: `COMMODITY_UNDERLYINGS`-style resolution already covers it
    // (securityId 51, IDX_I), `/quotes` returns a live SENSEX row, and its
    // options stream on **BSE_FNO** rather than NSE_FNO — a distinction the
    // bridge already handles and which had previously dropped every SENSEX
    // option tick when only NSE_FNO was matched.
    tradeable: true,
    aliases: ['sensex', 'bse sensex', 'bse30', 's&p bse sensex'],
  },

  // ---- Crypto — Binance spot ---------------------------------------------
  //
  // SPOT, not perpetuals. `CryptoWallet`/`CryptoOrder`/`CryptoPosition` are
  // spot-only by design (their schema comment: "no margin, no leverage, no
  // short selling"), and perps would need a funding-rate accrual model plus a
  // liquidation engine before a paper result meant anything. Spot is what this
  // infrastructure can actually settle honestly.
  {
    symbol: 'BTCUSDT',
    displayName: 'Bitcoin / Tether',
    market: 'CRYPTO',
    venue: 'BINANCE',
    kind: 'spot-crypto',
    executionStyle: 'spot',
    quoteCurrency: 'USD',
    quoteSource: 'binance',
    candleSource: 'binance',
    fractionalQuantity: true,
    lotSize: null,
    tradeable: true,
    aliases: ['btc', 'bitcoin', 'btc usdt', 'btc/usdt', 'btc usd'],
  },

  // ---- Gold — MCX front-month futures via Dhan ---------------------------
  //
  // WHY THIS AND NOT ANOTHER GOLD. The brief asked which gold we mean, and the
  // answer is decided by what has BOTH a real quote feed and real candles
  // today:
  //
  //   · MCX front-month futures — YES. Already resolved from the Dhan scrip
  //     master at boot (`COMMODITY_UNDERLYINGS` in live-feed-server.ts),
  //     already subscribed to the tick feed, and `/candles?symbol=GOLD`
  //     already serves Dhan historical bars. Nothing new is needed to observe
  //     it. CHOSEN.
  //   · XAU/USD spot via Twelve Data — rejected. The free tier is 8 requests
  //     a minute, the same limit that keeps FX on `chartSurface: 'embed'`; a
  //     30-second evaluation loop would exhaust it against one instrument.
  //   · Gold ETFs (GOLDBEES etc.) — rejected. NSE-session-bound, so they
  //     would test the Indian session again rather than gold, defeating the
  //     experiment's purpose.
  //   · Sovereign gold bonds — rejected. Illiquid; the fill model would be
  //     fiction.
  //
  // `lotSize: 100` is grams, and it is the known problem with this choice:
  // one GOLD lot is a multi-lakh notional. GOLDM (10 g) is listed below as the
  // sizing-friendly alternative for when the wallet cannot carry a full lot.
  {
    symbol: 'GOLD',
    displayName: 'Gold (MCX front-month)',
    market: 'GOLD',
    venue: 'MCX',
    kind: 'futures',
    executionStyle: 'futures',
    quoteCurrency: 'INR',
    quoteSource: 'dhan',
    candleSource: 'dhan',
    fractionalQuantity: false,
    lotSize: 100,
    tradeable: true,
    aliases: ['gold', 'mcx gold', 'gold futures'],
  },
  {
    symbol: 'GOLDM',
    displayName: 'Gold Mini (MCX front-month)',
    market: 'GOLD',
    venue: 'MCX',
    kind: 'futures',
    executionStyle: 'futures',
    quoteCurrency: 'INR',
    quoteSource: 'dhan',
    candleSource: 'dhan',
    fractionalQuantity: false,
    lotSize: 10,
    // Not yet in `COMMODITY_UNDERLYINGS`, so the bridge does not resolve or
    // subscribe it. `tradeable: false` states that honestly rather than
    // letting an agent be pointed at a symbol with no feed — the same
    // discipline `InstrumentRef.tradeable` already applies to crypto in the
    // web catalog. Flip this together with adding it to the bridge.
    tradeable: false,
    aliases: ['gold mini', 'goldm', 'mcx gold mini'],
  },
];

export const TRADABLE_SPECS: readonly TradableSpec[] = SPECS;

/** Look one up by symbol. Case-insensitive; null when unknown. */
export function tradableSpec(symbol: string): TradableSpec | null {
  const want = symbol.trim().toUpperCase();
  return SPECS.find((s) => s.symbol === want) ?? null;
}

/** Every spec in one experiment market. */
export function specsForMarket(market: ExperimentMarket): TradableSpec[] {
  return SPECS.filter((s) => s.market === market);
}

/**
 * Which experiment market a symbol belongs to, or null if it is not part of
 * the experiment.
 *
 * Used by the comparison layer to group results. Returning null rather than
 * defaulting to 'INDIA' matters: a stray symbol must be visibly ungrouped, not
 * silently attributed to the market with the most history.
 */
export function marketForSymbol(symbol: string): ExperimentMarket | null {
  return tradableSpec(symbol)?.market ?? null;
}
