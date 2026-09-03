import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InMemoryQuoteCache, MarketTick, isValidPrice, refKey } from '@tradew/market-data';
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
  /**
   * Guards against overlapping flushes. Writing thousands of rows can take
   * longer than the flush interval; without this, a slow flush would be joined
   * by the next one and the database would see ever-increasing concurrency
   * under exactly the conditions where it is already struggling.
   */
  private flushing = false;

  /** instrumentId -> last persisted price, for change detection. */
  private lastPersisted = new Map<string, string>();

  private stats = { received: 0, unresolved: 0, persisted: 0, skippedUnchanged: 0, flushes: 0, overlaps: 0, errors: 0 };
  private lastUnresolvedWarnAt = 0;

  /**
   * Upserts issued concurrently per flush. Postgres handles this comfortably
   * while a fully sequential loop cannot keep up with a wide universe, and an
   * unbounded Promise.all over thousands of rows would exhaust the pool.
   */
  private static readonly WRITE_CONCURRENCY = 25;

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
    if (this.flushing) {
      this.stats.overlaps++;
      return 0;
    }
    if (this.pending.size === 0) return 0;

    this.flushing = true;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    this.stats.flushes++;

    let written = 0;
    try {
      // Chunked concurrency rather than a sequential loop or an unbounded
      // Promise.all — see WRITE_CONCURRENCY.
      for (let i = 0; i < batch.length; i += TickPipelineService.WRITE_CONCURRENCY) {
        const chunk = batch.slice(i, i + TickPipelineService.WRITE_CONCURRENCY);
        const results = await Promise.all(chunk.map((entry) => this.writeOne(entry)));
        written += results.filter(Boolean).length;
      }
    } finally {
      this.flushing = false;
    }

    this.stats.persisted += written;
    return written;
  }

  private async writeOne({ tick, instrumentId }: { tick: MarketTick; instrumentId: string }): Promise<boolean> {
    try {
      const data = this.toQuoteData(tick);

      // Skip instruments whose price has not moved since the last write. Real
      // feeds are sparse — most instruments are idle most of the time — so this
      // removes the bulk of the write volume without losing anything: Quote is
      // a snapshot, and re-writing an identical snapshot changes nothing but
      // updatedAt.
      // `previousClose` is part of the fingerprint because it is now the field
      // that carries a closed market's only news. Keyed on price+volume alone,
      // the subscribe-time PREV_CLOSE packet — which has neither — matched the
      // empty fingerprint of every other priceless tick and was skipped, so the
      // one value worth persisting outside session hours never reached the row.
      const fingerprint = `${data.ltp?.toString() ?? ''}|${data.previousClose?.toString() ?? ''}|${data.volume?.toString() ?? ''}`;
      if (this.lastPersisted.get(instrumentId) === fingerprint) {
        this.stats.skippedUnchanged++;
        return false;
      }

      // `Quote.ltp` is non-nullable, so a first-ever row needs SOME price. The
      // only honest candidates are the tick's own price and the previous close
      // it carries — never a synthesized 0. `?? 0` here used to insert exactly
      // that: a Quote row asserting the instrument is worth nothing, which then
      // read back as a real price for the rest of its life because every later
      // update kept it (an OI-only or out-of-session tick writes no `ltp`).
      //
      // With no valid price to insert there is nothing to say about this
      // instrument yet, so an existing row is updated and no new one is
      // created. `updateMany` is the update-if-present form — zero rows matched
      // is a no-op, not an error.
      const createLtp = data.ltp ?? (isValidPrice(tick.previousClose) ? new Prisma.Decimal(tick.previousClose) : null);
      if (createLtp === null) {
        await this.prisma.quote.updateMany({ where: { instrumentId }, data });
      } else {
        // Quote.instrumentId is unique, so this is a genuine upsert rather than
        // find-then-write — no read-modify-write race between flushes.
        await this.prisma.quote.upsert({
          where: { instrumentId },
          update: data,
          create: { ...data, instrumentId, ltp: createLtp },
        });
      }
      this.lastPersisted.set(instrumentId, fingerprint);
      return true;
    } catch (err) {
      this.stats.errors++;
      this.logger.warn(`quote write failed for ${tick.ref.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
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
    // `isValidPrice` rather than `!== undefined`, as a second line of defence.
    // The Dhan parser already drops wire zeros, but this pipeline is
    // provider-neutral and a future adapter that reports 0-for-absent must not
    // be able to blank a good price here — a Quote row is a latest-value
    // snapshot, so a zero written into it is not corrected by anything.
    if (isValidPrice(tick.ltp)) data.ltp = new Prisma.Decimal(tick.ltp);
    if (isValidPrice(tick.open)) data.open = new Prisma.Decimal(tick.open);
    if (isValidPrice(tick.high)) data.high = new Prisma.Decimal(tick.high);
    if (isValidPrice(tick.low)) data.low = new Prisma.Decimal(tick.low);
    if (isValidPrice(tick.bid)) data.bid = new Prisma.Decimal(tick.bid);
    if (isValidPrice(tick.ask)) data.ask = new Prisma.Decimal(tick.ask);
    if (isValidPrice(tick.previousClose)) data.previousClose = new Prisma.Decimal(tick.previousClose);
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
