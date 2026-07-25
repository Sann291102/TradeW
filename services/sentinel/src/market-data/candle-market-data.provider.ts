import { Injectable, Logger } from '@nestjs/common';
import { SimulatedMarketDataProvider } from '@tradew/market-data';
import type {
  Candle,
  CandleInterval,
  MarketBreadth,
  MarketDataProvider,
  NewsItem,
  OptionChainEntry,
  Quote,
} from '@tradew/types';
import { PrismaService } from '../prisma.service';

/**
 * Sentinel's market-data provider — real data first, simulator only as a last
 * resort.
 *
 * Resolution order for candles (and breadth/VIX):
 *   1. Live feed  — the standalone Dhan bridge (live-feed-server.ts) when
 *      SENTINEL_LIVE_FEED_URL is set. Serves real Dhan OHLCV on demand for the
 *      *entire* resolved universe (indices, ~212 stocks, ETFs and MCX
 *      commodities), so any market the user selects reads real, not simulated.
 *   2. Candle table — persisted real history backfilled from Dhan
 *      (services/market-data/scripts/backfill-candles.ts). Used when the live
 *      bridge is unset/unreachable but the symbol was backfilled.
 *   3. Simulator  — deterministic fallback, so Sentinel can still observe when
 *      neither real source is available. This is the ONLY simulated path.
 *
 * The live bridge is a pragmatic step, not the final architecture: the Phase 4
 * ingestion pipeline (DHAN-MARKET-DATA-INTEGRATION.md) will write live Candle
 * rows to Postgres and this provider will read only the table. Keeping it
 * env-gated means that migration is a config change, and an absent/slow bridge
 * degrades cleanly rather than breaking /observe.
 */

const LIVE_FEED_URL = (process.env.SENTINEL_LIVE_FEED_URL ?? '').replace(/\/$/, '');
const LIVE_FEED_TIMEOUT_MS = Number(process.env.SENTINEL_LIVE_FEED_TIMEOUT_MS ?? 4000);

interface FeedCandle {
  timestamp: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}
interface FeedQuote {
  symbol: string;
  ltp: number;
  change?: number;
  changePct?: number;
  volume?: number;
}
interface FeedSnapshot {
  indices?: FeedQuote[];
  stocks?: FeedQuote[];
  etfs?: FeedQuote[];
  commodities?: FeedQuote[];
}

@Injectable()
export class CandleMarketDataProvider implements MarketDataProvider {
  readonly name = LIVE_FEED_URL ? 'live-feed+db-candle+simulated' : 'db-candle+simulated';
  private readonly logger = new Logger(CandleMarketDataProvider.name);
  private readonly fallback = new SimulatedMarketDataProvider();

  constructor(private readonly prisma: PrismaService) {}

  async getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    const live = await this.candlesFromLiveFeed(symbol, interval, from, to);
    if (live && live.length) return live;

    const stored = await this.candlesFromTable(symbol, interval, from, to);
    if (stored && stored.length) return stored;

    return this.fallback.getCandles(symbol, interval, from, to);
  }

  /** Real Dhan candles for any symbol the live bridge covers (incl. commodities). */
  private async candlesFromLiveFeed(
    symbol: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<Candle[] | null> {
    if (!LIVE_FEED_URL) return null;
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
    const url = `${LIVE_FEED_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&days=${days}`;
    const json = await this.fetchJson<{ candles?: FeedCandle[]; source?: string }>(url);
    if (!json || json.source !== 'dhan' || !Array.isArray(json.candles) || !json.candles.length) return null;

    const fromMs = from.getTime();
    const toMs = to.getTime();
    return json.candles
      .filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs)
      .map((c) => ({
        timestamp: new Date(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        openInterest: c.openInterest,
      }));
  }

  /** Persisted real history from the Candle table. */
  private async candlesFromTable(
    symbol: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<Candle[] | null> {
    try {
      const inst = await this.prisma.instrument.findUnique({ where: { symbol }, select: { id: true } });
      if (!inst) return null;
      const rows = await this.prisma.candle.findMany({
        where: { instrumentId: inst.id, timeframe: interval, bucketStart: { gte: from, lte: to } },
        orderBy: { bucketStart: 'asc' },
      });
      if (!rows.length) return null;
      return rows.map((r) => ({
        timestamp: r.bucketStart,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        openInterest: r.openInterest != null ? Number(r.openInterest) : undefined,
      }));
    } catch (err) {
      this.logger.warn(`candle table read failed for ${symbol} ${interval}: ${err}`);
      return null;
    }
  }

  /** Real market breadth + India VIX from the live bridge's snapshot. */
  async getMarketBreadth(): Promise<MarketBreadth> {
    if (LIVE_FEED_URL) {
      const snap = await this.fetchJson<FeedSnapshot>(`${LIVE_FEED_URL}/quotes`);
      const stocks = snap?.stocks ?? [];
      if (stocks.length) {
        let advances = 0;
        let declines = 0;
        let unchanged = 0;
        for (const s of stocks) {
          const chg = s.changePct ?? 0;
          if (chg > 0) advances++;
          else if (chg < 0) declines++;
          else unchanged++;
        }
        const vixRow = (snap?.indices ?? []).find((i) => /vix/i.test(i.symbol));
        if (advances + declines > 0) {
          return { advances, declines, unchanged, vix: vixRow?.ltp };
        }
      }
    }
    return this.fallback.getMarketBreadth();
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIVE_FEED_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      // bridge down / slow / unknown symbol — caller falls through to the next source
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Real Dhan LTP/quote from the live bridge's snapshot for any symbol it
   * covers (indices, stocks, ETFs, commodities); simulator only if the bridge
   * is unset/unreachable or doesn't carry the symbol.
   */
  async getQuote(symbol: string): Promise<Quote> {
    const live = await this.quoteFromLiveFeed(symbol);
    if (live) return live;
    return this.fallback.getQuote(symbol);
  }

  private async quoteFromLiveFeed(symbol: string): Promise<Quote | null> {
    if (!LIVE_FEED_URL) return null;
    const snap = await this.fetchJson<FeedSnapshot>(`${LIVE_FEED_URL}/quotes`);
    if (!snap) return null;
    const target = symbol.toUpperCase();
    const row = [
      ...(snap.indices ?? []),
      ...(snap.stocks ?? []),
      ...(snap.etfs ?? []),
      ...(snap.commodities ?? []),
    ].find((r) => r.symbol?.toUpperCase() === target);
    if (!row || typeof row.ltp !== 'number') return null;
    return {
      symbol,
      lastPrice: row.ltp,
      change: row.change ?? 0,
      changePercent: row.changePct ?? 0,
      volume: row.volume ?? 0,
      timestamp: new Date(),
    };
  }

  // --- still delegated to the simulator (option chain + news are separate
  //     integrations not yet served by the bridge) ---

  getOptionChain(symbol: string, expiry?: Date): Promise<OptionChainEntry[]> {
    return this.fallback.getOptionChain(symbol, expiry);
  }

  getNews(symbols?: string[], sinceHours?: number): Promise<NewsItem[]> {
    return this.fallback.getNews(symbols, sinceHours);
  }

  healthCheck(): Promise<boolean> {
    return this.fallback.healthCheck();
  }
}
