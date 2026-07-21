import type {
  Candle,
  CandleInterval,
  MarketBreadth,
  MarketDataProvider,
  NewsItem,
  OptionChainEntry,
  Quote,
} from '@tradew/types';
import { simulateCandles, simulateQuoteAt } from './ou-engine';

/**
 * The simulated `MarketDataProvider` — one implementation, used by every
 * service.
 *
 * Replaces the two divergent simulators described in MARKET-DATA-BASELINE.md
 * §5/§7. It keeps the exact `MarketDataProvider` contract from `@tradew/types`
 * (locked decision Q6), so Sentinel — the existing consumer — needs no
 * behavioural change beyond which class it injects.
 *
 * Anchors come from an injected resolver rather than being hardcoded. The
 * ingestor supplies real `previousClose`/`tickSize` from `Instrument`, so
 * simulated prices track the seeded instrument universe. When no resolver is
 * supplied (Sentinel standalone, tests), a deterministic symbol-derived anchor
 * is used so the provider still works with no database — this is what the old
 * Sentinel simulator did, preserved as a fallback rather than as the default.
 */

export interface InstrumentAnchor {
  symbol: string;
  /** Mean-reversion target for the walk. */
  previousClose: number;
  tickSize: number;
}

export type AnchorResolver = (symbol: string) => Promise<InstrumentAnchor | null>;

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/** Deterministic fallback anchor, used only when no resolver is configured. */
export function fallbackAnchor(symbol: string): InstrumentAnchor {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) | 0;
  const seeded = Math.abs(h) + 1;
  let previousClose: number;
  if (symbol.includes('BANKNIFTY')) previousClose = 52700;
  else if (symbol.includes('FINNIFTY')) previousClose = 23400;
  else if (symbol.includes('MIDCPNIFTY')) previousClose = 12800;
  else if (symbol.includes('SENSEX')) previousClose = 81500;
  else if (symbol.includes('NIFTY')) previousClose = 24850;
  else previousClose = 500 + (seeded % 3000);
  return { symbol, previousClose, tickSize: 0.05 };
}

export class SimulatedMarketDataProvider implements MarketDataProvider {
  readonly name = 'simulated';

  constructor(private readonly resolveAnchor?: AnchorResolver) {}

  private async anchorFor(symbol: string): Promise<InstrumentAnchor> {
    if (this.resolveAnchor) {
      const resolved = await this.resolveAnchor(symbol);
      if (resolved) return resolved;
    }
    return fallbackAnchor(symbol);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const anchor = await this.anchorFor(symbol);
    const sim = simulateQuoteAt(symbol, anchor.previousClose, anchor.tickSize, new Date());
    return {
      symbol,
      lastPrice: sim.ltp,
      change: sim.changeAbs,
      changePercent: sim.changePct,
      volume: sim.volume,
      timestamp: new Date(),
    };
  }

  async getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    const anchor = await this.anchorFor(symbol);
    return simulateCandles(symbol, anchor.previousClose, INTERVAL_MS[interval], from, to);
  }

  async getOptionChain(symbol: string, expiry?: Date): Promise<OptionChainEntry[]> {
    const anchor = await this.anchorFor(symbol);
    const sim = simulateQuoteAt(symbol, anchor.previousClose, anchor.tickSize, new Date());
    const strikeStep = sim.ltp > 40000 ? 100 : 50;
    const atm = Math.round(sim.ltp / strikeStep) * strikeStep;
    const exp = expiry ?? new Date(Date.now() + 7 * 86_400_000);
    const chain: OptionChainEntry[] = [];

    for (let i = -5; i <= 5; i++) {
      const strike = atm + i * strikeStep;
      const proximity = 1 - Math.abs(i) / 6;
      // Derived from the same deterministic walk as the quote, so the chain and
      // the underlying agree — they did not under the previous split simulators.
      const jitter = ((Math.abs(Math.sin(strike + sim.ltp)) * 1000) % 1000) / 1000;
      chain.push({
        strike,
        expiry: exp,
        callOI: Math.floor(200_000 * proximity * (0.7 + jitter * 0.6)),
        putOI: Math.floor(200_000 * proximity * (0.7 + (1 - jitter) * 0.6)),
        callVolume: Math.floor(60_000 * proximity * jitter),
        putVolume: Math.floor(60_000 * proximity * (1 - jitter)),
        callIV: 12 + jitter * 10 + Math.abs(i),
        putIV: 12 + (1 - jitter) * 10 + Math.abs(i),
        callLtp: Math.max(0.05, (sim.ltp - strike) * 0.5 + 50 * proximity),
        putLtp: Math.max(0.05, (strike - sim.ltp) * 0.5 + 50 * proximity),
      });
    }
    return chain;
  }

  async getMarketBreadth(): Promise<MarketBreadth> {
    // Hour-bucketed so breadth is stable within an hour rather than flickering
    // on every poll — matches how a real breadth snapshot behaves.
    const bucket = Math.floor(Date.now() / 3_600_000);
    const jitter = ((Math.abs(Math.sin(bucket)) * 1000) % 1000) / 1000;
    const advances = Math.floor(800 + jitter * 1200);
    return {
      advances,
      declines: Math.floor(2200 - advances * 0.8),
      unchanged: 120,
      vix: 11 + jitter * 12,
    };
  }

  async getNews(symbols?: string[], sinceHours = 24): Promise<NewsItem[]> {
    // Simulation has no news source. Real providers (NSE/BSE/screener/Dhan)
    // plug in behind this same interface.
    void symbols;
    void sinceHours;
    return [];
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
