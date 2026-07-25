import { FO_STOCK_UNIVERSE } from '@/lib/mock/foUniverse';

/**
 * The market universe the Sentinel workspace can be pointed at — user-centric
 * market selection (the "market head" control). A user chooses which market
 * they want Sentinel to read, and the whole page re-derives for that symbol.
 *
 * `real: true` marks symbols Sentinel reasons on with **live Dhan data**. This
 * now covers the whole selectable universe: the Sentinel service reads candles
 * and breadth/VIX on demand from the Dhan live-feed bridge (indices, ~212 F&O
 * stocks, ETFs and MCX commodities), backed by the persisted Candle table, and
 * only falls back to the simulator if neither real source is reachable. See
 * knowledge/Patterns/2026-07-24 - Sentinel live data across the full universe.
 */

export type MarketKind = 'index' | 'commodity' | 'stock';

export interface Market {
  symbol: string;
  name: string;
  kind: MarketKind;
  /** Sentinel has real backfilled candle history for this symbol. */
  real?: boolean;
}

/** Symbols with persisted real history in the Candle table (survive a feed
 *  restart). Live coverage is broader — the whole universe below is served live
 *  by the Dhan bridge — so `real` is set for every market; this set only marks
 *  which additionally have durable, backfilled history. */
export const BACKFILLED_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'RELIANCE', 'COALINDIA']);

export const INDEX_MARKETS: Market[] = [
  { symbol: 'NIFTY', name: 'Nifty 50', kind: 'index' },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank', kind: 'index' },
  { symbol: 'FINNIFTY', name: 'Fin Nifty', kind: 'index' },
  { symbol: 'SENSEX', name: 'BSE Sensex', kind: 'index' },
];

/** MCX front-month commodities — live on the dashboard tick feed; Sentinel
 *  analysis runs on the simulator until their history is backfilled too. */
export const COMMODITY_MARKETS: Market[] = [
  { symbol: 'GOLD', name: 'Gold', kind: 'commodity' },
  { symbol: 'SILVER', name: 'Silver', kind: 'commodity' },
  { symbol: 'CRUDEOIL', name: 'Crude Oil', kind: 'commodity' },
  { symbol: 'NATURALGAS', name: 'Natural Gas', kind: 'commodity' },
  { symbol: 'COPPER', name: 'Copper', kind: 'commodity' },
];

export const STOCK_MARKETS: Market[] = FO_STOCK_UNIVERSE.map((s) => ({
  symbol: s.symbol,
  name: s.name,
  kind: 'stock' as const,
}));

// The Dhan bridge serves live data for the entire resolved universe (indices,
// F&O stocks, ETFs, commodities), so every selectable market reads live.
function withReal(m: Market): Market {
  return { ...m, real: true };
}

export const INDICES = INDEX_MARKETS.map(withReal);
export const COMMODITIES = COMMODITY_MARKETS.map(withReal);
export const STOCKS = STOCK_MARKETS.map(withReal);

/** Flat, de-duplicated universe (indices → commodities → stocks). */
export const ALL_MARKETS: Market[] = (() => {
  const seen = new Set<string>();
  const out: Market[] = [];
  for (const m of [...INDICES, ...COMMODITIES, ...STOCKS]) {
    if (seen.has(m.symbol)) continue;
    seen.add(m.symbol);
    out.push(m);
  }
  return out;
})();

const BY_SYMBOL = new Map(ALL_MARKETS.map((m) => [m.symbol, m]));

export const DEFAULT_MARKET = 'NIFTY';

export function findMarket(symbol: string): Market {
  return BY_SYMBOL.get(symbol) ?? { symbol, name: symbol, kind: 'stock' };
}

/** Case-insensitive symbol/name match, ordered by symbol. */
export function searchMarkets(query: string, limit = 40): Market[] {
  const q = query.trim().toLowerCase();
  const pool = q
    ? ALL_MARKETS.filter((m) => m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    : ALL_MARKETS;
  return [...pool]
    .sort((a, b) => Number(!!b.real) - Number(!!a.real) || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}
