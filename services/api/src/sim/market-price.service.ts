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
 * Canonical option-contract symbol: `UNDERLYING:YYYYMMDD:STRIKE:CE|PE`
 * (e.g. `NIFTY:20260728:23800:CE`). Colon-delimited because NSE symbols
 * contain letters, digits, `&` and `-` (BAJAJ-AUTO, M&M) but never a colon,
 * so parsing back out is unambiguous. This one string is the OMS's whole
 * option identity — it's what the frontend sends to /sim/orders and what the
 * Instrument row is keyed by, so nothing else in the order flow needs to grow
 * option-specific fields. The frontend builds the identical format in oms.ts.
 */
export interface ParsedOptionSymbol {
  underlying: string;
  expiryIso: string;
  strike: number;
  optionType: 'CE' | 'PE';
}

export function buildOptionSymbol(underlying: string, expiryIso: string, strike: number, optionType: 'CE' | 'PE'): string {
  return `${underlying.toUpperCase()}:${expiryIso.replace(/-/g, '')}:${strike}:${optionType}`;
}

export function parseOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  const parts = symbol.split(':');
  if (parts.length !== 4) return null;
  const [underlying, ymd, strikeStr, type] = parts;
  if (!/^\d{8}$/.test(ymd)) return null;
  if (type !== 'CE' && type !== 'PE') return null;
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying: underlying.toUpperCase(),
    expiryIso: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    strike,
    optionType: type,
  };
}

interface BridgeOptionInstrument {
  securityId: string;
  exchangeSegment: string;
  dhanInstrument: string;
  lotSize: number | null;
  tickSize: number | null;
  tradingSymbol: string;
  displayName: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
}

interface BridgeOptionLeg {
  ltp: number;
  bid: number;
  ask: number;
}
interface BridgeOptionChain {
  spot: number | null;
  strikes: Array<{ strike: number; ce: BridgeOptionLeg | null; pe: BridgeOptionLeg | null }>;
}

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

    // Option contracts carry their identity in the symbol itself
    // (UNDERLYING:YYYYMMDD:STRIKE:CE|PE) and resolve through the bridge's
    // scrip-master lookup rather than the flat /instrument quote path.
    const option = parseOptionSymbol(key);
    if (option) return this.resolveOptionInstrument(key, option);

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

  /** Resolves (and upserts) the Instrument row for one option contract from
   *  the bridge's scrip-master lookup. Priced later, live, by getOptionPrice. */
  private async resolveOptionInstrument(canonicalSymbol: string, parsed: ParsedOptionSymbol): Promise<Instrument> {
    const query =
      `symbol=${encodeURIComponent(parsed.underlying)}&expiry=${parsed.expiryIso}` +
      `&strike=${parsed.strike}&type=${parsed.optionType}`;
    let res: Response;
    try {
      res = await fetch(`${DHAN_LIVE_URL}/instrument/option?${query}`);
    } catch (err) {
      this.logger.error(`resolveOptionInstrument(${canonicalSymbol}): live-feed bridge unreachable`, err as Error);
      throw new NotFoundException(`Could not resolve option contract "${canonicalSymbol}" — market data is temporarily unavailable`);
    }
    if (!res.ok) throw new NotFoundException(`Could not resolve option contract "${canonicalSymbol}" — market data is temporarily unavailable`);
    const { instrument } = (await res.json()) as { instrument: BridgeOptionInstrument | null };
    if (!instrument) throw new NotFoundException(`Unknown option contract "${canonicalSymbol}"`);

    const exchange = instrument.exchangeSegment.startsWith('BSE')
      ? 'BSE'
      : instrument.exchangeSegment.startsWith('MCX')
        ? 'MCX'
        : 'NSE';
    // Dhan's scrip-master tick is in paise (5 -> ₹0.05); normalise to rupees so
    // the ticket's limit-price step and rounding are sane.
    const tickSize = instrument.tickSize != null && instrument.tickSize >= 1 ? instrument.tickSize / 100 : instrument.tickSize ?? 0.05;
    const data = {
      displayName: instrument.displayName,
      type: 'OPTION' as InstrumentType,
      exchange,
      underlying: instrument.underlying,
      expiryDate: new Date(`${instrument.expiry}T00:00:00Z`),
      strikePrice: instrument.strike,
      optionType: instrument.optionType,
      lotSize: instrument.lotSize ?? 1,
      tickSize,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      dhanInstrument: instrument.dhanInstrument,
      tradingSymbol: instrument.tradingSymbol,
      active: true,
      metadataSource: 'dhan-live-bridge',
      metadataSyncedAt: new Date(),
    };
    return this.prisma.instrument.upsert({ where: { symbol: canonicalSymbol }, create: { symbol: canonicalSymbol, ...data }, update: data });
  }

  /** Live LTP/bid/ask for an already-resolved instrument. */
  async getPrice(instrument: Instrument): Promise<LivePrice> {
    if (instrument.type === 'OPTION') return this.getOptionPrice(instrument);
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

  /** Live premium for one option contract, read from the SAME bridge
   *  /optionchain the Option Chain table and the chart use — so a paper fill
   *  can never diverge from the price the user is looking at. */
  private async getOptionPrice(instrument: Instrument): Promise<LivePrice> {
    if (!instrument.underlying || !instrument.expiryDate || instrument.strikePrice == null || !instrument.optionType) {
      throw new NotFoundException(`Option contract "${instrument.symbol}" is missing its contract details`);
    }
    const expiryIso = instrument.expiryDate.toISOString().slice(0, 10);
    const strike = Number(instrument.strikePrice);
    const type = instrument.optionType === 'CE' ? 'CE' : 'PE';
    const query = `symbol=${encodeURIComponent(instrument.underlying)}&expiry=${expiryIso}`;

    let chain: BridgeOptionChain;
    try {
      const res = await fetch(`${DHAN_LIVE_URL}/optionchain?${query}`);
      if (!res.ok) throw new Error(`optionchain returned ${res.status}`);
      chain = (await res.json()) as BridgeOptionChain;
    } catch (err) {
      this.logger.error(`getOptionPrice(${instrument.symbol}): option chain unreachable`, err as Error);
      throw new NotFoundException('Market data is temporarily unavailable — try again shortly');
    }

    const row = chain.strikes?.find((s) => Math.abs(s.strike - strike) < 0.001);
    const leg = type === 'CE' ? row?.ce : row?.pe;
    if (!leg || !(leg.ltp > 0)) {
      // A real but illiquid strike can legitimately have no premium right now —
      // reject rather than fill a paper trade at ₹0.
      throw new NotFoundException(`No live price for ${instrument.displayName} right now`);
    }

    let marketOpen = false;
    try {
      marketOpen = (await this.getSnapshot()).marketOpen;
    } catch {
      // Non-fatal: a missing market-open flag must not block a placeable order;
      // the matching engine's own market-hours guard is the authority anyway.
    }
    return {
      ltp: leg.ltp,
      bid: leg.bid > 0 ? leg.bid : leg.ltp * 0.9995,
      ask: leg.ask > 0 ? leg.ask : leg.ltp * 1.0005,
      marketOpen,
    };
  }
}
