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

export interface MarketDataProvider {
  readonly name: string;
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]>;
  getOptionChain(symbol: string, expiry?: Date): Promise<OptionChainEntry[]>;
  getMarketBreadth(): Promise<MarketBreadth>;
  getNews(symbols?: string[], sinceHours?: number): Promise<NewsItem[]>;
  healthCheck(): Promise<boolean>;
}
