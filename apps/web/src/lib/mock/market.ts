/**
 * Mock market data for the Milestone 2 UI conversion.
 *
 * Values mirror the canonical terminal (apps/terminal/index.html) so the
 * converted React UI reproduces the original's look with realistic numbers.
 * This is presentation-only placeholder data — per the milestone, business
 * logic (live feeds via services/market-data) is NOT implemented here. When the
 * real feed lands, these shapes are what the components already consume, so
 * swapping mock → live is a data-source change, not a component change.
 */

export interface IndexQuote {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePct: number;
  spark: number[];
}

export interface MoverRow {
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
}

export interface SectorTile {
  key: string;
  name: string;
  changePct: number;
}

export interface TrendingChip {
  symbol: string;
  changePct: number;
}

export type NewsCategory = 'company' | 'market' | 'economy' | 'action';

export interface NewsItem {
  id: string;
  category: NewsCategory;
  text: string;
  symbol?: string;
  time: string;
}

// deterministic pseudo-sparkline so SSR and client render identically (no Math.random)
function spark(seed: number, up: boolean): number[] {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < 24; i++) {
    const wave = Math.sin((i + seed) * 0.6) * 3 + Math.cos((i + seed) * 0.3) * 2;
    v += wave + (up ? 0.35 : -0.35);
    out.push(Number(v.toFixed(2)));
  }
  return out;
}

/** The five headline indices shown in the dashboard overview + ticker. */
export const INDEX_QUOTES: IndexQuote[] = [
  { symbol: 'NIFTY', name: 'NIFTY 50', ltp: 23882.15, change: 128.4, changePct: 0.54, spark: spark(1, true) },
  { symbol: 'BANKNIFTY', name: 'NIFTY Bank', ltp: 56742.3, change: -212.6, changePct: -0.37, spark: spark(4, false) },
  { symbol: 'SENSEX', name: 'BSE Sensex', ltp: 78250.6, change: 402.1, changePct: 0.52, spark: spark(2, true) },
  { symbol: 'FINNIFTY', name: 'Fin Nifty', ltp: 26480.9, change: 84.2, changePct: 0.32, spark: spark(7, true) },
  { symbol: 'INDIAVIX', name: 'India VIX', ltp: 14.68, change: -0.42, changePct: -2.78, spark: spark(9, false) },
];

/** Extra symbols the scrolling ticker carries beyond the headline indices. */
export const TICKER_EXTRA: IndexQuote[] = [
  { symbol: 'MIDCPNIFTY', name: 'Midcap Select', ltp: 13120.5, change: 45.3, changePct: 0.35, spark: [] },
  { symbol: 'NIFTYIT', name: 'NIFTY IT', ltp: 42350.1, change: 318.7, changePct: 0.76, spark: [] },
  { symbol: 'NIFTYAUTO', name: 'NIFTY Auto', ltp: 26140.4, change: -96.2, changePct: -0.37, spark: [] },
  { symbol: 'NIFTYPHARMA', name: 'NIFTY Pharma', ltp: 22480.8, change: 71.5, changePct: 0.32, spark: [] },
];

export const TOP_GAINERS: MoverRow[] = [
  { symbol: 'TATAMOTORS', name: 'Tata Motors', ltp: 984.3, changePct: 3.42 },
  { symbol: 'INFY', name: 'Infosys', ltp: 1876.5, changePct: 2.88 },
  { symbol: 'RELIANCE', name: 'Reliance Ind.', ltp: 2954.1, changePct: 1.94 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', ltp: 1712.0, changePct: 1.36 },
  { symbol: 'SBIN', name: 'State Bank', ltp: 842.7, changePct: 1.12 },
];

export const TOP_LOSERS: MoverRow[] = [
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', ltp: 6720.4, changePct: -2.61 },
  { symbol: 'ADANIENT', name: 'Adani Ent.', ltp: 2410.9, changePct: -1.98 },
  { symbol: 'HINDUNILVR', name: 'HUL', ltp: 2388.2, changePct: -1.44 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints', ltp: 2296.6, changePct: -1.23 },
  { symbol: 'TITAN', name: 'Titan Co.', ltp: 3312.5, changePct: -0.87 },
];

export const SECTORS: SectorTile[] = [
  { key: 'it', name: 'IT', changePct: 0.86 },
  { key: 'bank', name: 'Bank', changePct: -0.37 },
  { key: 'auto', name: 'Auto', changePct: 0.42 },
  { key: 'pharma', name: 'Pharma', changePct: 0.31 },
  { key: 'fmcg', name: 'FMCG', changePct: -0.22 },
  { key: 'metal', name: 'Metal', changePct: 1.12 },
  { key: 'energy', name: 'Energy', changePct: 0.58 },
  { key: 'realty', name: 'Realty', changePct: -0.94 },
  { key: 'psu', name: 'PSU Bank', changePct: 0.73 },
];

export const TRENDING: TrendingChip[] = [
  { symbol: 'TATAMOTORS', changePct: 3.4 },
  { symbol: 'INFY', changePct: 2.9 },
  { symbol: 'RELIANCE', changePct: 1.9 },
  { symbol: 'ZOMATO', changePct: 4.1 },
  { symbol: 'IRFC', changePct: -1.2 },
  { symbol: 'YESBANK', changePct: 2.3 },
];

export const NEWS: NewsItem[] = [
  { id: 'n1', category: 'market', text: 'Nifty holds above 23,800 as IT and metals lead broad-based buying.', time: '09:41' },
  { id: 'n2', category: 'company', text: 'Infosys gains after upbeat deal-pipeline commentary from management.', symbol: 'INFY', time: '09:38' },
  { id: 'n3', category: 'economy', text: 'India VIX cools ~3% signalling lower near-term volatility expectations.', time: '09:30' },
  { id: 'n4', category: 'action', text: 'Tata Motors ex-dividend date set; watch for price adjustment.', symbol: 'TATAMOTORS', time: '09:22' },
  { id: 'n5', category: 'company', text: 'Bajaj Finance slips as street digests margin-guidance revision.', symbol: 'BAJFINANCE', time: '09:18' },
  { id: 'n6', category: 'market', text: 'FIIs net buyers in the cash segment for a second straight session.', time: '09:05' },
];

export interface WatchRow {
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
  spark: number[];
}

export const WATCHLIST: WatchRow[] = [
  { symbol: 'NIFTY', name: 'NIFTY 50', ltp: 23882.15, changePct: 0.54, spark: spark(1, true) },
  { symbol: 'BANKNIFTY', name: 'NIFTY Bank', ltp: 56742.3, changePct: -0.37, spark: spark(4, false) },
  { symbol: 'RELIANCE', name: 'Reliance Ind.', ltp: 2954.1, changePct: 1.94, spark: spark(3, true) },
  { symbol: 'INFY', name: 'Infosys', ltp: 1876.5, changePct: 2.88, spark: spark(6, true) },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', ltp: 1712.0, changePct: 1.36, spark: spark(8, true) },
  { symbol: 'TATAMOTORS', name: 'Tata Motors', ltp: 984.3, changePct: 3.42, spark: spark(2, true) },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', ltp: 6720.4, changePct: -2.61, spark: spark(5, false) },
];

export const WATCHLIST_TABS = ['My Watchlist', 'F&O', 'Indices', 'Commodities'];

/** Portfolio summary shown on the dashboard (mock paper account). */
export const PORTFOLIO_SUMMARY = {
  investment: 486500,
  currentValue: 512840,
  overallPnl: 26340,
  todayPnl: 4820,
  openPositions: 6,
  marginAvailable: 213400,
  marginUsed: 86600,
  equity: 512840,
};
