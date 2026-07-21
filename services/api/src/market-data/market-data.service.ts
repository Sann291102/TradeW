import { Injectable, NotFoundException } from '@nestjs/common';
import { Instrument, Quote } from '@prisma/client';
import { marketStatusAt, type MarketStatus } from '@tradew/market-data';
import { PrismaService } from '../prisma/prisma.service';

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
  /**
   * Provenance of the underlying data, read from Quote.source rather than
   * hardcoded. Widened from the literal 'simulated' now that a real provider
   * can write these rows — the value is whatever the ingestor recorded, so a
   * response can never misrepresent simulated data as live.
   */
  source: string;
}

/**
 * Market data reads.
 *
 * PURE READS — this service does not generate, simulate or persist market data.
 *
 * It used to: every request ran the simulated engine and wrote the result back
 * to `Quote`, making a GET a write and recomputing up to 375 minutes of walk
 * per call. That was workable while simulation was the only source, but it is
 * structurally incompatible with a real provider — Dhan caps market-quote REST
 * at 1 request/second account-wide, so a single 5-index dashboard load would
 * exhaust the budget five times over
 * (DHAN-MARKET-DATA-INTEGRATION.md §1).
 *
 * Data now flows one way:
 *
 *   feed -> services/market-data (ingest) -> Quote
 *   request -> services/api (read) -> response
 *
 * `services/market-data` is the sole writer. If quotes look stale, that
 * service is not running — which is a far better failure mode than an API that
 * silently invents prices.
 */
@Injectable()
export class MarketDataService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Project a persisted row onto the wire shape.
   *
   * The DTO is unchanged from when this method also computed the values, so no
   * existing caller breaks. Nullable columns are coalesced against `ltp` —
   * a row written by a ticker-mode subscription legitimately has no OHLC yet,
   * and reporting 0 would render as a -100% move.
   */
  private toDto(instrument: Instrument, quote: Quote): QuoteDto {
    const ltp = Number(quote.ltp);
    const previousClose = quote.previousClose !== null ? Number(quote.previousClose) : ltp;
    const changeAbs = ltp - previousClose;

    return {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      displayName: instrument.displayName,
      ltp,
      change: round2(changeAbs),
      changePct: previousClose !== 0 ? round2((changeAbs / previousClose) * 100) : 0,
      open: quote.open !== null ? Number(quote.open) : ltp,
      high: quote.high !== null ? Number(quote.high) : ltp,
      low: quote.low !== null ? Number(quote.low) : ltp,
      close: previousClose,
      bid: quote.bid !== null ? Number(quote.bid) : ltp,
      ask: quote.ask !== null ? Number(quote.ask) : ltp,
      volume: quote.volume !== null ? Number(quote.volume) : 0,
      // Session state is a pure function of the clock, not of the stored row,
      // so it is derived here rather than persisted and read back stale.
      marketStatus: marketStatusAt(new Date()),
      updatedAt: quote.updatedAt,
      source: quote.source,
    };
  }

  private async loadWithQuote(where: { id: string } | { symbol: string }): Promise<{ instrument: Instrument; quote: Quote } | null> {
    const instrument = await this.prisma.instrument.findUnique({ where });
    if (!instrument) return null;
    // Quote.instrumentId is unique (Migration 1), so this is a point lookup.
    const quote = await this.prisma.quote.findUnique({ where: { instrumentId: instrument.id } });
    if (!quote) return null;
    return { instrument, quote };
  }

  /** GET /market-data/quote/:instrumentId — unchanged contract. */
  async quote(instrumentId: string): Promise<QuoteDto> {
    const found = await this.loadWithQuote({ id: instrumentId });
    if (!found) throw new NotFoundException('Quote not found');
    return this.toDto(found.instrument, found.quote);
  }

  /** GET /market-data/quote-by-symbol/:symbol — the frontend knows symbols, not UUIDs. */
  async quoteBySymbol(symbol: string): Promise<QuoteDto> {
    const found = await this.loadWithQuote({ symbol });
    if (!found) throw new NotFoundException(`No quote for symbol "${symbol}"`);
    return this.toDto(found.instrument, found.quote);
  }

  /**
   * GET /market-data/quotes?symbols=A,B,C — batch read.
   *
   * One query for instruments and one for their quotes, rather than a pair per
   * symbol. That mattered less when each symbol was being simulated anyway;
   * with pure reads the N+1 was the only remaining cost.
   */
  async quotesBySymbols(symbols: string[]): Promise<QuoteDto[]> {
    const unique = Array.from(new Set(symbols.filter(Boolean)));
    if (unique.length === 0) return [];

    const instruments = await this.prisma.instrument.findMany({ where: { symbol: { in: unique } } });
    if (instruments.length === 0) return [];

    const quotes = await this.prisma.quote.findMany({ where: { instrumentId: { in: instruments.map((i) => i.id) } } });
    const quoteByInstrument = new Map(quotes.map((q) => [q.instrumentId, q]));

    const dtos: QuoteDto[] = [];
    for (const instrument of instruments) {
      const quote = quoteByInstrument.get(instrument.id);
      if (quote) dtos.push(this.toDto(instrument, quote));
    }
    // Preserve the caller's ordering — the ticker renders in the order asked for.
    const order = new Map(unique.map((s, i) => [s, i]));
    return dtos.sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
  }

  /** GET /market-data/indices — the 5-index dashboard feed. */
  async indices(): Promise<QuoteDto[]> {
    return this.quotesBySymbols([...DASHBOARD_INDEX_SYMBOLS]);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
