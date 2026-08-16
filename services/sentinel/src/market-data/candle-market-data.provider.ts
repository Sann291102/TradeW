import { Injectable, Logger } from '@nestjs/common';
import type {
  Candle,
  CandleInterval,
  MarketBreadth,
  MarketDataProvider,
  NewsItem,
  OptionChainEntry,
  OptionContractRef,
  Quote,
} from '@tradew/types';
import { istDateKey } from '@tradew/market-data';
import { PrismaService } from '../prisma.service';

/**
 * Sentinel's market-data provider — REAL data only.
 *
 * Resolution order for candles (and breadth/VIX):
 *   1. Live feed  — the standalone Dhan bridge (live-feed-server.ts) when
 *      SENTINEL_LIVE_FEED_URL is set. Serves real Dhan OHLCV on demand for the
 *      *entire* resolved universe (indices, ~212 stocks, ETFs and MCX
 *      commodities), so any market the user selects reads real, not simulated.
 *   2. Candle table — persisted real history backfilled from Dhan
 *      (services/market-data/scripts/backfill-candles.ts). Used when the live
 *      bridge is unset/unreachable but the symbol was backfilled.
 *   3. Nothing. There is no simulator fallback.
 *
 * Removed 2026-07-26: the third tier used to be a SimulatedMarketDataProvider
 * so /observe could always answer. That meant Sentinel produced a complete,
 * confident-looking observation — day classification, signals, timeline — off
 * invented candles whenever the bridge was down, with nothing in the response
 * marking it as fabricated. An observation-and-education product whose whole
 * value is trustworthy context cannot afford that. It now raises
 * MarketDataUnavailableError and the workspace reports that it is not
 * connected.
 *
 * The live bridge is a pragmatic step, not the final architecture: the Phase 4
 * ingestion pipeline (DHAN-MARKET-DATA-INTEGRATION.md) will write live Candle
 * rows to Postgres and this provider will read only the table.
 */

/**
 * Raised when neither real source can serve a request. Mapped to HTTP 503 by
 * the controller so the web workspace can say exactly what is disconnected.
 */
export class MarketDataUnavailableError extends Error {
  constructor(what: string, symbol?: string) {
    super(
      `No real market data available${symbol ? ` for ${symbol}` : ''} (${what}). ` +
        'The Dhan live-feed bridge is unreachable and no backfilled candles exist for it. ' +
        'Sentinel does not substitute simulated data.',
    );
    this.name = 'MarketDataUnavailableError';
  }
}

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

/** One leg of a strike as the bridge's `/optionchain` serves it. */
interface FeedOptionLeg {
  ltp?: number;
  oi?: number;
  volume?: number;
  iv?: number;
}
interface FeedOptionChain {
  spot?: number | null;
  strikes?: { strike: number; ce?: FeedOptionLeg | null; pe?: FeedOptionLeg | null }[];
}

/**
 * How long a read chain is reused.
 *
 * Shorter than the bridge's own chain TTL would be pointless (the call would
 * just hit that cache); longer would let OI walls go stale across a sweep. The
 * observation cadences this serves are 45s (`/observe`) and 60s (the watch
 * sweep), so 30s means neither is ever served a chain it has already seen
 * twice.
 */
const OPTION_CACHE_TTL_MS = 30_000;
/** Expiry lists change on expiry, not on ticks. See `getOptionExpiries`. */
const EXPIRY_CACHE_TTL_MS = 15 * 60_000;

function contractLabel(c: OptionContractRef): string {
  return `${c.symbol} ${c.expiry} ${c.strike} ${c.side}`;
}

@Injectable()
export class CandleMarketDataProvider implements MarketDataProvider {
  readonly name = LIVE_FEED_URL ? 'live-feed+db-candle' : 'db-candle';
  private readonly logger = new Logger(CandleMarketDataProvider.name);

  /** symbol:expiry → last read chain. See OPTION_CACHE_TTL_MS. */
  private readonly chainCache = new Map<string, { at: number; entries: OptionChainEntry[] }>();
  /** symbol → traded expiries, nearest first. See EXPIRY_CACHE_TTL_MS. */
  private readonly expiryCache = new Map<string, { at: number; expiries: string[] }>();

  constructor(private readonly prisma: PrismaService) {}

  async getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    const live = await this.candlesFromLiveFeed(symbol, interval, from, to);
    if (live && live.length) return live;

    const stored = await this.candlesFromTable(symbol, interval, from, to);
    if (stored && stored.length) return stored;

    this.logger.warn(`no real candles for ${symbol} ${interval} — refusing to simulate`);
    throw new MarketDataUnavailableError(`${interval} candles`, symbol);
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
    // Unknown, not flat. Zeros are how "no breadth reading" is expressed to
    // composeSnapshot: `declines > 0` is false so breadthRatio becomes null,
    // and an absent vix becomes null. Both factors then report "no data"
    // rather than contributing an invented neutral reading. Breadth is
    // optional context, so unlike candles this does not fail the observation.
    return { advances: 0, declines: 0, unchanged: 0 };
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
    throw new MarketDataUnavailableError('quote', symbol);
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

  // --- options ---------------------------------------------------------
  //
  // `getOptionChain` returned `[]` for every symbol from 2026-07-26 until
  // 2026-08-16, with a comment describing that as "the honest answer" pending
  // the Phase 4 ingestion pipeline. It was honest and it was also unnecessary:
  // the live-feed bridge has served `/optionchain` and
  // `/optionchain/expirylist` the whole time — the web workspace's option
  // chain panel, its CE/PE charts and its strike pickers all read them. So the
  // ENGINE was the only part of TradeW that could not see the option market,
  // while the screen beside it showed a full chain.
  //
  // Consequences of that gap, all now closed: `snapshot.optionChain` was
  // always null, so PCR / max pain / OI walls never reached the confidence
  // engine's option factor, `buildOptionContext` reported `unavailable: true`
  // on every observation, and `positioningNotes` never produced a line.

  async getOptionChain(symbol: string, expiry?: Date): Promise<OptionChainEntry[]> {
    if (!LIVE_FEED_URL) return [];

    const expiryIso = expiry ? istDateKey(expiry) : (await this.getOptionExpiries(symbol))[0];
    if (!expiryIso) return []; // no options market for this instrument

    const cacheKey = `${symbol.toUpperCase()}:${expiryIso}`;
    const cached = this.chainCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OPTION_CACHE_TTL_MS) return cached.entries;

    const json = await this.fetchJson<FeedOptionChain>(
      `${LIVE_FEED_URL}/optionchain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiryIso)}`,
    );
    if (!json || !Array.isArray(json.strikes) || json.strikes.length === 0) {
      // Rate-limited, bridge down, or genuinely no chain. All three degrade to
      // "no chain read", never to a fabricated one — the option factor reports
      // no data, exactly as it did when this method was a stub.
      return cached?.entries ?? [];
    }

    const expiryDate = new Date(`${expiryIso}T00:00:00+05:30`);
    const entries: OptionChainEntry[] = json.strikes
      .filter((row) => Number.isFinite(row.strike))
      .map((row) => ({
        strike: row.strike,
        expiry: expiryDate,
        callOI: row.ce?.oi ?? 0,
        putOI: row.pe?.oi ?? 0,
        callVolume: row.ce?.volume ?? 0,
        putVolume: row.pe?.volume ?? 0,
        callIV: row.ce?.iv ?? undefined,
        putIV: row.pe?.iv ?? undefined,
        callLtp: row.ce?.ltp ?? undefined,
        putLtp: row.pe?.ltp ?? undefined,
      }));

    this.chainCache.set(cacheKey, { at: Date.now(), entries });
    return entries;
  }

  /**
   * Traded expiries, nearest first.
   *
   * Cached far longer than the chain itself: an expiry list changes when a
   * contract expires, not tick to tick, and every chain read starts with this
   * call. Without the cache a watch sweep over a dozen symbols would put two
   * dozen calls into the bridge's shared Dhan queue, which enforces a 3.1s
   * floor between option-family calls — the sweep would spend minutes waiting
   * on a list that had not changed.
   */
  async getOptionExpiries(symbol: string): Promise<string[]> {
    if (!LIVE_FEED_URL) return [];
    const key = symbol.toUpperCase();
    const cached = this.expiryCache.get(key);
    if (cached && Date.now() - cached.at < EXPIRY_CACHE_TTL_MS) return cached.expiries;

    const json = await this.fetchJson<{ expiries?: string[] }>(
      `${LIVE_FEED_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`,
    );
    // A failed read is not "no options market" — leaving the cache alone means
    // the next call retries instead of pinning an empty list for the TTL.
    if (!json || !Array.isArray(json.expiries)) return cached?.expiries ?? [];

    const expiries = [...json.expiries].sort();
    this.expiryCache.set(key, { at: Date.now(), expiries });
    return expiries;
  }

  /**
   * Real Dhan OHLC for ONE option contract — the premium series.
   *
   * The bridge already sanitises these (Dhan occasionally returns the
   * underlying's prices on an option securityId; `/candles/option` rescales
   * against the live premium). Deliberately not re-sanitised here: two
   * independent corrections of the same artefact is how a correctly-priced
   * series gets scaled twice.
   */
  async getOptionCandles(
    contract: OptionContractRef,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<Candle[]> {
    if (!LIVE_FEED_URL) throw new MarketDataUnavailableError('option candles', contractLabel(contract));

    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
    const url =
      `${LIVE_FEED_URL}/candles/option?symbol=${encodeURIComponent(contract.symbol)}` +
      `&expiry=${encodeURIComponent(contract.expiry)}&strike=${contract.strike}` +
      `&type=${contract.side}&interval=${interval}&days=${days}`;

    const json = await this.fetchJson<{ candles?: FeedCandle[]; source?: string }>(url);
    if (!json || json.source !== 'dhan' || !Array.isArray(json.candles) || !json.candles.length) {
      // No Candle-table fallback: contract OHLC has never been backfilled, so
      // there is no second real source to fall through to. Throwing is what
      // makes "could not read this leg" reach the caller as a fact rather than
      // an empty series that reads like a flat one.
      throw new MarketDataUnavailableError(`${interval} option candles`, contractLabel(contract));
    }

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

  // --- not yet served by the bridge ---
  // This used to return generated headlines. Empty is the honest answer:
  // NewsIntelligenceService reports no published flow rather than inventing
  // sentiment. A real integration lands with the Phase 4 pipeline.

  async getNews(_symbols?: string[], _sinceHours?: number): Promise<NewsItem[]> {
    return [];
  }

  /** Healthy only when a real source can actually answer. */
  async healthCheck(): Promise<boolean> {
    if (!LIVE_FEED_URL) return false;
    return (await this.fetchJson<FeedSnapshot>(`${LIVE_FEED_URL}/quotes`)) !== null;
  }
}
