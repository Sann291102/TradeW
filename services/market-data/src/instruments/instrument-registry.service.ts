import { Injectable, Logger } from '@nestjs/common';
import { InstrumentRef, isExchangeSegment } from '@tradew/market-data';
import type { ExchangeSegment, InstrumentAnchor } from '@tradew/market-data';
import { PrismaService } from '../prisma.service';

/**
 * Resolves instruments between the three identities in play, and supplies the
 * simulator's price anchors.
 *
 * The feed and the database do not speak the same language. The Dhan wire
 * carries only `(exchangeSegment, securityId)` and no symbol; the platform
 * addresses instruments by `symbol`; and persistence needs the `Instrument.id`
 * UUID. Doing that lookup per tick would mean a query per tick, so it is
 * cached here and refreshed explicitly.
 *
 * The cache is intentionally simple: the instrument universe changes at most
 * once a day (scrip master sync), so a full reload is cheaper and far easier to
 * reason about than incremental invalidation.
 */
@Injectable()
export class InstrumentRegistryService {
  private readonly logger = new Logger(InstrumentRegistryService.name);

  private bySymbol = new Map<string, CachedInstrument>();
  private byBrokerKey = new Map<string, CachedInstrument>();
  private loadedAt: Date | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Load (or reload) the active instrument universe into memory. */
  async reload(): Promise<number> {
    const rows = await this.prisma.instrument.findMany({
      where: { active: true },
      select: {
        id: true,
        symbol: true,
        displayName: true,
        securityId: true,
        exchangeSegment: true,
        tickSize: true,
        quotes: { select: { previousClose: true, ltp: true }, take: 1 },
      },
    });

    const bySymbol = new Map<string, CachedInstrument>();
    const byBrokerKey = new Map<string, CachedInstrument>();

    for (const row of rows) {
      const quote = row.quotes[0];
      const entry: CachedInstrument = {
        id: row.id,
        symbol: row.symbol,
        displayName: row.displayName,
        securityId: row.securityId ?? undefined,
        exchangeSegment: isExchangeSegment(row.exchangeSegment) ? row.exchangeSegment : undefined,
        tickSize: Number(row.tickSize),
        // previousClose is the walk's mean-reversion target. Falling back to
        // ltp keeps a freshly-seeded instrument (no prior close yet) usable
        // rather than anchoring it at zero.
        previousClose: quote?.previousClose ? Number(quote.previousClose) : quote?.ltp ? Number(quote.ltp) : null,
      };
      bySymbol.set(row.symbol, entry);
      if (entry.securityId && entry.exchangeSegment) {
        byBrokerKey.set(`${entry.exchangeSegment}:${entry.securityId}`, entry);
      }
    }

    this.bySymbol = bySymbol;
    this.byBrokerKey = byBrokerKey;
    this.loadedAt = new Date();
    this.logger.log(`loaded ${rows.length} active instrument(s); ${byBrokerKey.size} broker-mapped`);
    return rows.length;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadedAt) await this.reload();
  }

  /**
   * Resolve a feed ref to a known instrument.
   *
   * Broker key is tried first because the live feed only supplies that;
   * symbol is the fallback for the simulator, which subscribes by symbol.
   */
  resolve(ref: InstrumentRef): CachedInstrument | null {
    if (ref.securityId && ref.exchangeSegment) {
      const found = this.byBrokerKey.get(`${ref.exchangeSegment}:${ref.securityId}`);
      if (found) return found;
    }
    return ref.symbol ? this.bySymbol.get(ref.symbol) ?? null : null;
  }

  async subscriptionSet(): Promise<InstrumentRef[]> {
    await this.ensureLoaded();
    return [...this.bySymbol.values()].map((i) => ({
      symbol: i.symbol,
      securityId: i.securityId,
      exchangeSegment: i.exchangeSegment,
    }));
  }

  /** Anchor resolver handed to the simulated provider and feed. */
  anchorResolver = async (symbol: string): Promise<InstrumentAnchor | null> => {
    await this.ensureLoaded();
    const found = this.bySymbol.get(symbol);
    if (!found || found.previousClose === null) return null;
    return { symbol, previousClose: found.previousClose, tickSize: found.tickSize };
  };

  stats() {
    return {
      loadedAt: this.loadedAt,
      total: this.bySymbol.size,
      brokerMapped: this.byBrokerKey.size,
      unmapped: this.bySymbol.size - this.byBrokerKey.size,
    };
  }
}

export interface CachedInstrument {
  id: string;
  symbol: string;
  displayName: string;
  securityId?: string;
  /** Narrowed at load time via isExchangeSegment — an unrecognised value in the
   *  column becomes undefined rather than leaking an unvalidated string into
   *  feed subscriptions. */
  exchangeSegment?: ExchangeSegment;
  tickSize: number;
  previousClose: number | null;
}
