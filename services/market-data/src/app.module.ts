import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { FeedManagerService } from './ingestion/feed-manager.service';
import { TickPipelineService } from './ingestion/tick-pipeline.service';
import { InstrumentRegistryService } from './instruments/instrument-registry.service';
import { PrismaService } from './prisma.service';
import { ScripMasterService } from './scrip-master/scrip-master.service';
import { UniverseRefreshScheduler } from './universe/universe-refresh.scheduler';
import { UniverseSyncService } from './universe/universe-sync.service';

/**
 * Market data ingestion runtime.
 *
 * Writes; it does not serve market data to clients. `services/api` remains the
 * sole public ingress (ARCHITECTURE.md §1) and reads what this service persists.
 * The only HTTP surface here is health/status for operators.
 */
@Module({
  controllers: [HealthController],
  providers: [
    PrismaService,
    InstrumentRegistryService,
    TickPipelineService,
    FeedManagerService,
    ScripMasterService,
    // The tradable universe's WRITE side. It lives here rather than in
    // services/api because a sync downloads ~15 MiB and writes hundreds of
    // thousands of rows — work that belongs in the ingestion runtime, not on a
    // request path. The scheduler is inert unless UNIVERSE_REFRESH_ENABLED=true.
    UniverseSyncService,
    UniverseRefreshScheduler,
  ],
  exports: [ScripMasterService, UniverseSyncService],
})
export class AppModule {}
