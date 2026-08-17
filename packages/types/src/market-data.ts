/**
 * MarketDataProvider abstraction (locked decision Q6).
 *
 * Default implementations: simulation, paper-trading feed, historical replay.
 * Future: free NSE/BSE/screener sources, then Dhan — added behind this same
 * contract. Consumers (Sentinel's Market Intelligence, TradeW AI, charts)
 * never know which provider is behind it.
 */

export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** open interest, when the instrument has one */
  openInterest?: number;
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '1d';

export interface Quote {
  symbol: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: Date;
}

export interface OptionChainEntry {
  strike: number;
  expiry: Date;
  callOI: number;
  putOI: number;
  callVolume: number;
  putVolume: number;
  callIV?: number;
  putIV?: number;
  callLtp?: number;
  putLtp?: number;
}

export interface MarketBreadth {
  advances: number;
  declines: number;
  unchanged: number;
  /** index-level volatility, e.g. India VIX */
  vix?: number;
}

export interface NewsItem {
  id: string;
  headline: string;
  summary?: string;
  source: string;
  url?: string;
  publishedAt: Date;
  symbols: string[];
  /** unscheduled/high-impact flag for volatility correlation */
  unscheduled?: boolean;
}

/** One side of an option contract. */
export type OptionSide = 'CE' | 'PE';

/** A specific traded contract — underlying, expiry, strike and side. */
export interface OptionContractRef {
  /** Underlying symbol, e.g. 'NIFTY'. */
  symbol: string;
  /** Expiry as 'YYYY-MM-DD' (IST), matching the provider's own expiry list. */
  expiry: string;
  strike: number;
  side: OptionSide;
}

export interface MarketDataProvider {
  readonly name: string;
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]>;
  getOptionChain(symbol: string, expiry?: Date): Promise<OptionChainEntry[]>;
  getMarketBreadth(): Promise<MarketBreadth>;
  getNews(symbols?: string[], sinceHours?: number): Promise<NewsItem[]>;
  healthCheck(): Promise<boolean>;

  /**
   * Traded expiries for `symbol`, nearest first, as 'YYYY-MM-DD' (IST).
   *
   * OPTIONAL — and optional is the honest shape, not a convenience. Reading a
   * single option contract's own OHLC needs a provider that can resolve a
   * securityId from (underlying, expiry, strike, side); the Dhan bridge can,
   * the simulator cannot and must never pretend to. A caller that needs
   * contract series therefore has to check for the capability, which is
   * exactly the check that keeps "Sentinel could not read this leg" distinct
   * from "Sentinel read this leg and it was flat".
   *
   * Returns [] for an instrument with no options market (a commodity, most
   * equities) — an empty list is an answer, an absent method is not.
   *
   * MUST THROW rather than return [] when the expiry list could not be READ.
   * The two are different facts and the caller acts differently on each: an
   * empty list is a property of the instrument, and a failed read is a property
   * of the integration. Collapsing them caused the 2026-08-17 incident, where a
   * refused Dhan credential made every implementation return [] and the UI told
   * the user that NIFTY — India's most liquid option chain — has no option
   * chain. See services/sentinel/src/market-data/candle-market-data.provider.ts.
   */
  getOptionExpiries?(symbol: string): Promise<string[]>;

  /**
   * OHLC for ONE option contract — the premium series, not the underlying's.
   *
   * Optional for the same reason as `getOptionExpiries`. See
   * `services/sentinel/src/intelligence/contract-alignment.ts` for why Sentinel
   * needs the premium series at all rather than inferring the leg's behaviour
   * from the underlying: a call premium can fall while the index rises, and
   * that divergence is the observation.
   */
  getOptionCandles?(
    contract: OptionContractRef,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<Candle[]>;
}
