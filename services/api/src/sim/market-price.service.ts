import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Instrument, InstrumentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DHAN_LIVE_URL = process.env.DHAN_LIVE_URL || 'http://localhost:4600';
/** Snapshot cache — the OMS may need a price for several orders within the
 *  same request/tick; one bridge call covers all of them (see getSnapshot). */
const QUOTES_CACHE_TTL_MS = 2_000;

export interface LivePrice {
  ltp: number;
  bid: number;
  ask: number;
  marketOpen: boolean;
}

interface BridgeQuote {
  symbol: string;
  ltp: number;
  bid: number;
  ask: number;
  marketStatus: 'open' | 'closed';
}
interface BridgeSnapshot {
  marketOpen: boolean;
  indices: BridgeQuote[];
  stocks: BridgeQuote[];
  etfs: BridgeQuote[];
  commodities: BridgeQuote[];
}
interface BridgeInstrument {
  symbol: string;
  displayName: string;
  tradingSymbol: string;
  exchange: string;
  exchangeSegment: string;
  securityId: string;
  instrumentType: 'INDEX' | 'EQUITY' | 'ETF' | 'COMMODITY_FUT';
  isin: string | null;
  lotSize: number;
  tickSize: number;
  expiryDate: string | null;
}

/** Bridge's finer-grained classification collapses onto Prisma's existing
 *  `InstrumentType` enum (INDEX/OPTION/EQUITY/FUTURE) — ETFs trade like
 *  equities and get no dedicated value; commodity futures are FUTURE. */
const BRIDGE_TO_PRISMA_TYPE: Record<BridgeInstrument['instrumentType'], InstrumentType> = {
  INDEX: 'INDEX',
  EQUITY: 'EQUITY',
  ETF: 'EQUITY',
  COMMODITY_FUT: 'FUTURE',
};

/**
 * All live pricing and instrument metadata for the paper-trading OMS comes
 * from the standalone Dhan live-feed bridge
 * (services/market-data/scripts/live-feed-server.ts) — the exact same real
 * price source already driving the dashboard, charts and option chain.
 *
 * Deliberately NOT `MarketDataService` / Postgres `Quote`: that table is
 * written by a *different* process (services/market-data's NestJS
 * ingestor), which defaults to a simulated random-walk feed. Filling paper
 * orders against that would silently diverge from the real price the user
 * is looking at on screen — confusing at best, wrong at worst. See
 * MARKET-DATA-ARCHITECTURE.md and DHAN-MARKET-DATA-INTEGRATION.md for why
 * the two pipelines exist; this service intentionally bridges the OMS to
 * the live one, not the simulated one.
 *
 * Postgres `Instrument` rows are still the FK target every Order/Trade/
 * Position references (durable state stays in Postgres) — they're resolved
 * and upserted lazily here, on first use, rather than depending on the
 * manual `scrip:sync` CLI having already covered a given symbol. That CLI's
 * segment-scoped, run-by-hand sync remains useful for other parts of the
 * app; the OMS just doesn't block on it.
 */
@Injectable()
export class MarketPriceService {
  private readonly logger = new Logger(MarketPriceService.name);
  private snapshotCache: { at: number; snapshot: BridgeSnapshot } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private async getSnapshot(): Promise<BridgeSnapshot> {
    if (this.snapshotCache && Date.now() - this.snapshotCache.at < QUOTES_CACHE_TTL_MS) {
      return this.snapshotCache.snapshot;
    }
    const res = await fetch(`${DHAN_LIVE_URL}/quotes`);
    if (!res.ok) throw new Error(`live-feed bridge /quotes returned ${res.status}`);
    const snapshot = (await res.json()) as BridgeSnapshot;
    this.snapshotCache = { at: Date.now(), snapshot };
    return snapshot;
  }

  /** Resolves the Postgres Instrument row for `symbol`, upserting from the
   *  live bridge on first use (or if never resolved before). */
  async resolveInstrument(symbol: string): Promise<Instrument> {
    const key = symbol.toUpperCase();
    const existing = await this.prisma.instrument.findUnique({ where: { symbol: key } });
    if (existing && existing.active) return existing;

    let res: Response;
    try {
      res = await fetch(`${DHAN_LIVE_URL}/instrument?symbol=${encodeURIComponent(key)}`);
    } catch (err) {
      this.logger.error(`resolveInstrument(${key}): live-feed bridge unreachable`, err as Error);
      throw new NotFoundException(`Could not resolve instrument "${key}" — market data is temporarily unavailable`);
    }
    if (!res.ok) throw new NotFoundException(`Could not resolve instrument "${key}" — market data is temporarily unavailable`);
    const { instrument } = (await res.json()) as { instrument: BridgeInstrument | null };
    if (!instrument) throw new NotFoundException(`Unknown instrument "${key}"`);

    const data = {
      displayName: instrument.displayName,
      type: BRIDGE_TO_PRISMA_TYPE[instrument.instrumentType],
      exchange: instrument.exchange,
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      isin: instrument.isin,
      tradingSymbol: instrument.tradingSymbol,
      active: true,
      metadataSource: 'dhan-live-bridge',
      metadataSyncedAt: new Date(),
    };
    return this.prisma.instrument.upsert({ where: { symbol: key }, create: { symbol: key, ...data }, update: data });
  }

  /** Live LTP/bid/ask for an already-resolved instrument. */
  async getPrice(instrument: Instrument): Promise<LivePrice> {
    if (instrument.type === 'OPTION') {
      // Option-contract pricing needs the bridge's /optionchain endpoint,
      // keyed by (underlying, expiry, strike, type) rather than a flat
      // symbol lookup — deliberately not wired in this phase (Phase 1 scope
      // is underlyings: indices/stocks/ETFs/commodities). Reject cleanly
      // rather than silently mispricing a real order against nothing.
      throw new NotFoundException('Option contract order placement is not available yet — underlyings only in this phase');
    }
    let snapshot: BridgeSnapshot;
    try {
      snapshot = await this.getSnapshot();
    } catch (err) {
      this.logger.error(`getPrice(${instrument.symbol}): live-feed bridge unreachable`, err as Error);
      throw new NotFoundException('Market data is temporarily unavailable — try again shortly');
    }
    const all = [...snapshot.indices, ...snapshot.stocks, ...snapshot.etfs, ...snapshot.commodities];
    const quote = all.find((q) => q.symbol === instrument.symbol);
    if (!quote) throw new NotFoundException(`No live quote for "${instrument.symbol}" right now`);
    return {
      ltp: quote.ltp,
      // Dhan's quote-mode ticks frequently carry bid=ask=0 (no depth in this
      // mode, especially after hours) — fall back to a small synthetic
      // spread around LTP so LIMIT/SL fill logic always has something
      // sensible to compare against, rather than treating 0 as a real,
      // crossable price.
      bid: quote.bid > 0 ? quote.bid : quote.ltp * 0.9995,
      ask: quote.ask > 0 ? quote.ask : quote.ltp * 1.0005,
      marketOpen: quote.marketStatus === 'open',
    };
  }
}
