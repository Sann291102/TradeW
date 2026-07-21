import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InMemoryQuoteCache, MarketTick, refKey } from '@tradew/market-data';
import { InstrumentRegistryService } from '../instruments/instrument-registry.service';
import { PrismaService } from '../prisma.service';

/**
 * Tick → cache → database.
 *
 * The two writes are deliberately on different cadences. Ticks arrive
 * tick-by-tick from a real feed; writing each one to Postgres would be a write
 * per instrument per tick for no benefit, because `Quote` is a latest-value
 * snapshot (MARKET-DATA-BASELINE.md §1) — intermediate values are not history
 * and nothing reads them. So:
 *
 *   · cache    — every tick, synchronously, for hot reads
 *   · Postgres — coalesced per instrument on a flush interval
 *
 * Nothing is lost by coalescing: the latest tick always wins, and a snapshot
 * table has no notion of the ticks in between. Once `Candle` exists (Migration
 * 2) the per-minute aggregation is what will preserve intra-interval detail.
 */
@Injectable()
export class TickPipelineService implements OnModuleDestroy {
  private readonly logger = new Logger(TickPipelineService.name);
  readonly cache = new InMemoryQuoteCache();

  /** instrumentId -> latest tick awaiting persistence. */
  private pending = new Map<string, { tick: MarketTick; instrumentId: string }>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private stats = { received: 0, unresolved: 0, persisted: 0, flushes: 0, errors: 0 };
  private lastUnresolvedWarnAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly instruments: InstrumentRegistryService,
  ) {}

  start(flushIntervalMs: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flush(), flushIntervalMs);
    this.logger.log(`tick pipeline started (flush every ${flushIntervalMs}ms)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain on shutdown so the last prices seen are not lost on a deploy.
    await this.flush();
  }

  /**
   * Ingest one tick. Never throws — a bad tick must not take down the feed
   * handler, and the feed is far more expensive to re-establish than one tick
   * is to drop.
   */
  async ingest(tick: MarketTick): Promise<void> {
    try {
      this.stats.received++;
      const instrument = this.instruments.resolve(tick.ref);
      if (!instrument) {
        this.stats.unresolved++;
        this.warnUnresolved(tick);
        return;
      }

      // Normalise the ref so cache keys are stable regardless of whether the
      // tick arrived from the symbol-addressed simulator or the
      // securityId-addressed live feed.
      const enriched: MarketTick = {
        ...tick,
        ref: {
          symbol: instrument.symbol,
          securityId: instrument.securityId,
          exchangeSegment: tick.ref.exchangeSegment,
        },
      };

      await this.cache.set(refKey(enriched.ref), enriched);
      // Latest wins — this is the coalescing step.
      this.pending.set(instrument.id, { tick: enriched, instrumentId: instrument.id });
    } catch (err) {
      this.stats.errors++;
      this.logger.warn(`failed to ingest tick: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Write every pending instrument's latest tick. */
  async flush(): Promise<number> {
    if (this.pending.size === 0) return 0;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    this.stats.flushes++;

    let written = 0;
    for (const { tick, instrumentId } of batch) {
      try {
        const data = this.toQuoteData(tick);
        // Quote.instrumentId is unique, so this is a genuine upsert rather
        // than find-then-write — no read-modify-write race between flushes.
        // `ltp` is non-nullable on create; a tick that carries no price (an
        // OI-only packet, say) would otherwise fail the insert, so it seeds
        // from whatever price the tick does have.
        await this.prisma.quote.upsert({
          where: { instrumentId },
          update: data,
          create: { ...data, instrumentId, ltp: data.ltp ?? new Prisma.Decimal(tick.previousClose ?? 0) },
        });
        written++;
      } catch (err) {
        this.stats.errors++;
        this.logger.warn(`quote write failed for ${tick.ref.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.stats.persisted += written;
    return written;
  }

  /**
   * Map a tick onto Quote columns.
   *
   * Only fields the tick actually carries are written. A Ticker-mode
   * subscription has no OHLC, and blanking those columns on every tick would
   * destroy good data from a richer earlier tick.
   */
  private toQuoteData(tick: MarketTick): QuoteWriteData {
    const data: Record<string, unknown> = { source: tick.source };
    if (tick.ltp !== undefined) data.ltp = new Prisma.Decimal(tick.ltp);
    if (tick.open !== undefined) data.open = new Prisma.Decimal(tick.open);
    if (tick.high !== undefined) data.high = new Prisma.Decimal(tick.high);
    if (tick.low !== undefined) data.low = new Prisma.Decimal(tick.low);
    if (tick.bid !== undefined) data.bid = new Prisma.Decimal(tick.bid);
    if (tick.ask !== undefined) data.ask = new Prisma.Decimal(tick.ask);
    if (tick.previousClose !== undefined) data.previousClose = new Prisma.Decimal(tick.previousClose);
    if (tick.volume !== undefined) {
      // Quote.volume is BigInt; the Dhan wire types volume as int32, so a very
      // active low-priced counter can approach that ceiling. Clamping at zero
      // guards against a wrapped negative reaching the database.
      data.volume = BigInt(Math.max(0, Math.trunc(tick.volume)));
    }
    return data as QuoteWriteData;
  }

  /** Rate-limited so an unmapped instrument cannot flood the log at tick rate. */
  private warnUnresolved(tick: MarketTick): void {
    const now = Date.now();
    if (now - this.lastUnresolvedWarnAt < 30_000) return;
    this.lastUnresolvedWarnAt = now;
    this.logger.warn(
      `tick for unknown instrument (symbol="${tick.ref.symbol}" securityId=${tick.ref.securityId ?? 'none'} ` +
        `segment=${tick.ref.exchangeSegment ?? 'none'}) — run the scrip master sync if this persists`,
    );
  }

  snapshot() {
    return { ...this.stats, pending: this.pending.size, cacheSize: this.cache.snapshot().length };
  }
}

/**
 * Scalar-only Quote columns. Deliberately not `Prisma.QuoteUpdateInput`, which
 * also permits relation operations on `instrument` — those are valid for an
 * update but illegal in the `create` branch of an upsert, so one shape cannot
 * serve both.
 */
type QuoteWriteData = {
  source: string;
  ltp?: Prisma.Decimal;
  open?: Prisma.Decimal;
  high?: Prisma.Decimal;
  low?: Prisma.Decimal;
  bid?: Prisma.Decimal;
  ask?: Prisma.Decimal;
  previousClose?: Prisma.Decimal;
  volume?: bigint;
};
