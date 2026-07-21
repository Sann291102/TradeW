import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { FeedManagerService } from './ingestion/feed-manager.service';
import { TickPipelineService } from './ingestion/tick-pipeline.service';
import { InstrumentRegistryService } from './instruments/instrument-registry.service';
import { PrismaService } from './prisma.service';
import { ScripMasterService } from './scrip-master/scrip-master.service';

/**
 * Market data ingestion runtime.
 *
 * Writes; it does not serve market data to clients. `services/api` remains the
 * sole public ingress (ARCHITECTURE.md §1) and reads what this service persists.
 * The only HTTP surface here is health/status for operators.
 */
@Module({
  controllers: [HealthController],
  providers: [PrismaService, InstrumentRegistryService, TickPipelineService, FeedManagerService, ScripMasterService],
  exports: [ScripMasterService],
})
export class AppModule {}
