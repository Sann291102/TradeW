import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Instrument, Quote } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SimulatedEngineService, type MarketStatus } from './simulated-engine.service';

/** The 5 canonical indices the Index Dashboard / ticker show (Milestone 4, Step 2). */
export const DASHBOARD_INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'] as const;

export interface QuoteDto {
  instrumentId: string;
  symbol: string;
  displayName: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number; // previous session's close (standard OHLC-quote convention, see schema comment)
  bid: number;
  ask: number;
  volume: number;
  marketStatus: MarketStatus;
  updatedAt: Date;
  /** Always 'simulated' today — no live provider is wired in (backend audit, 2026-07-18).
   *  Kept as an explicit field so no response can be mistaken for a live feed. */
  source: 'simulated';
}

@Injectable()
export class MarketDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SimulatedEngineService,
  ) {}

  /** Computes the current simulated quote and persists it onto the instrument's
   *  Quote row — Quote acts as the latest-value cache/store, not a request-scoped throwaway. */
  private async enrich(instrument: Instrument, quoteRow: Quote): Promise<QuoteDto> {
    const anchor = quoteRow.previousClose ? Number(quoteRow.previousClose) : Number(quoteRow.ltp);
    const tickSize = Number(instrument.tickSize);
    const sim = this.engine.quoteAt(instrument.symbol, anchor, tickSize, new Date());

    const updated = await this.prisma.quote.update({
      where: { id: quoteRow.id },
      data: {
        ltp: new Prisma.Decimal(sim.ltp),
        open: new Prisma.Decimal(sim.open),
        high: new Prisma.Decimal(sim.high),
        low: new Prisma.Decimal(sim.low),
        bid: new Prisma.Decimal(sim.bid),
        ask: new Prisma.Decimal(sim.ask),
        volume: BigInt(sim.volume),
        source: 'simulated',
      },
    });

    return {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      displayName: instrument.displayName,
      ltp: sim.ltp,
      change: sim.changeAbs,
      changePct: sim.changePct,
      open: sim.open,
      high: sim.high,
      low: sim.low,
      close: anchor,
      bid: sim.bid,
      ask: sim.ask,
      volume: sim.volume,
      marketStatus: sim.marketStatus,
      updatedAt: updated.updatedAt,
      source: 'simulated',
    };
  }

  private async loadWithQuote(where: Prisma.InstrumentWhereUniqueInput): Promise<{ instrument: Instrument; quote: Quote } | null> {
    const instrument = await this.prisma.instrument.findUnique({ where });
    if (!instrument) return null;
    const quote = await this.prisma.quote.findFirst({ where: { instrumentId: instrument.id }, orderBy: { updatedAt: 'desc' } });
    if (!quote) return null;
    return { instrument, quote };
  }

  /** Existing contract — GET /market-data/quote/:instrumentId. Response shape
   *  is now enriched (open/high/low/bid/ask/volume/marketStatus/source) but
   *  every field the M2/M3 frontend already read (ltp, symbol, displayName)
   *  is still present, so no caller breaks. */
  async quote(instrumentId: string): Promise<QuoteDto> {
    const found = await this.loadWithQuote({ id: instrumentId });
    if (!found) throw new NotFoundException('Quote not found');
    return this.enrich(found.instrument, found.quote);
  }

  /** New — GET /market-data/quote-by-symbol/:symbol. The frontend generally
   *  knows symbols ("NIFTY"), not instrument UUIDs; this avoids forcing every
   *  caller through /instruments/search first just to get an id. */
  async quoteBySymbol(symbol: string): Promise<QuoteDto> {
    const found = await this.loadWithQuote({ symbol });
    if (!found) throw new NotFoundException(`No quote for symbol "${symbol}"`);
    return this.enrich(found.instrument, found.quote);
  }

  /** New — GET /market-data/quotes?symbols=A,B,C. Batch read, one round trip,
   *  for the ticker/watchlist/dashboard (avoids N sequential quote calls). */
  async quotesBySymbols(symbols: string[]): Promise<QuoteDto[]> {
    const unique = Array.from(new Set(symbols.filter(Boolean)));
    const results = await Promise.all(
      unique.map(async (s) => {
        const found = await this.loadWithQuote({ symbol: s });
        return found ? this.enrich(found.instrument, found.quote) : null;
      }),
    );
    return results.filter((r): r is QuoteDto => r !== null);
  }

  /** New — GET /market-data/indices. The 5-index dashboard, purpose-built but
   *  internally just quotesBySymbols — no duplicated logic. */
  async indices(): Promise<QuoteDto[]> {
    return this.quotesBySymbols([...DASHBOARD_INDEX_SYMBOLS]);
  }
}
