import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  createMarketFeed,
  FeedMode,
  FeedStatusEvent,
  loadMarketDataConfigFromEnv,
  MarketFeed,
  MarketDataConfig,
} from '@tradew/market-data';
import { InstrumentRegistryService } from '../instruments/instrument-registry.service';
import { TickPipelineService } from './tick-pipeline.service';
import { dhanWebSocketFactory } from './dhan-websocket-factory';

/**
 * Owns the feed's lifecycle: which provider is active, when it connects, what
 * it is subscribed to, and what happens when it drops.
 *
 * This service is the reason `services/market-data` is a separate deployable
 * rather than a module inside `services/api`. The broker feed connection set is
 * a per-account resource — Dhan allows five connections per user and drops the
 * oldest with code 805 on a sixth. If the API scaled to N replicas, each would
 * open its own set and they would evict each other. One ingestor, one
 * connection set (ARCHITECTURE.md §2, DHAN-MARKET-DATA-INTEGRATION.md §4).
 *
 * Reconnection itself lives in the feed implementation, not here — it is
 * provider-specific (Dhan's backoff and 805 handling have no analogue in the
 * simulator). This service reacts to the resulting status transitions.
 */
@Injectable()
export class FeedManagerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FeedManagerService.name);
  private feed: MarketFeed | null = null;
  private config: MarketDataConfig = loadMarketDataConfigFromEnv();
  private statusHistory: FeedStatusEvent[] = [];
  private started = false;

  constructor(
    private readonly instruments: InstrumentRegistryService,
    private readonly pipeline: TickPipelineService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Opt-out rather than opt-in: the ingestor's entire job is to run the feed,
    // so a deployment that silently ingested nothing would be worse than one
    // that fails loudly. INGESTION_ENABLED=false is for maintenance windows.
    if (process.env.INGESTION_ENABLED === 'false') {
      this.logger.warn('INGESTION_ENABLED=false — feed not started');
      return;
    }
    try {
      await this.start();
    } catch (err) {
      // A feed that cannot start must not prevent the process from booting:
      // the health endpoint is how an operator finds out what went wrong.
      this.logger.error(`feed failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.config = loadMarketDataConfigFromEnv();

    const count = await this.instruments.reload();
    if (count === 0) {
      this.logger.warn('no active instruments — feed will start but subscribe to nothing');
    }

    this.feed = createMarketFeed(this.config, {
      resolveAnchor: this.instruments.anchorResolver,
      // Real transport for MARKET_DATA_FEED=dhan. Still gated on credentials
      // being present (registry.ts throws without them) and on the licensing
      // decision in DHAN-MARKET-DATA-INTEGRATION.md §3.1 before this is
      // pointed at a production account.
      webSocketFactory: dhanWebSocketFactory,
    });

    this.feed.onStatus((event) => this.recordStatus(event));
    this.feed.onTick((tick) => void this.pipeline.ingest(tick));

    await this.feed.start();

    const refs = await this.instruments.subscriptionSet();
    const mode = (process.env.MARKET_DATA_FEED_MODE as FeedMode) || 'full';
    await this.feed.subscribe(refs, mode);

    const flushMs = Number(process.env.MARKET_DATA_FLUSH_MS || 2000);
    this.pipeline.start(flushMs);

    this.started = true;
    this.logger.log(`feed "${this.feed.name}" started — ${refs.length} instrument(s) in ${mode} mode`);
  }

  async stop(): Promise<void> {
    if (this.feed) {
      await this.feed.stop().catch((err) => this.logger.warn(`feed stop failed: ${err}`));
      this.feed = null;
    }
    this.started = false;
  }

  /** Re-read the instrument universe and resubscribe. Called after a scrip sync. */
  async resubscribe(): Promise<number> {
    if (!this.feed) return 0;
    await this.instruments.reload();
    const refs = await this.instruments.subscriptionSet();
    const mode = (process.env.MARKET_DATA_FEED_MODE as FeedMode) || 'full';
    await this.feed.subscribe(refs, mode);
    this.logger.log(`resubscribed to ${refs.length} instrument(s)`);
    return refs.length;
  }

  private recordStatus(event: FeedStatusEvent): void {
    // Bounded history so a long reconnect storm cannot grow without limit.
    this.statusHistory = [...this.statusHistory.slice(-49), event];
    const detail = [event.reason, event.code !== undefined ? `code=${event.code}` : null, event.attempt ? `attempt=${event.attempt}` : null]
      .filter(Boolean)
      .join(' ');
    if (event.status === 'error') this.logger.error(`feed ${event.feed}: ${event.status} ${detail}`);
    else if (event.status === 'reconnecting') this.logger.warn(`feed ${event.feed}: ${event.status} ${detail}`);
    else this.logger.log(`feed ${event.feed}: ${event.status} ${detail}`);
  }

  health() {
    return {
      enabled: process.env.INGESTION_ENABLED !== 'false',
      started: this.started,
      provider: this.config.feed,
      feedStatus: this.feed?.status ?? 'idle',
      instruments: this.instruments.stats(),
      pipeline: this.pipeline.snapshot(),
      recentStatus: this.statusHistory.slice(-10),
    };
  }
}
