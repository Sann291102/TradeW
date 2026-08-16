import { Module } from '@nestjs/common';
import { NseController } from './nse.controller';
import { NseService } from './nse.service';

/**
 * NSE public data. No PrismaModule — nothing is persisted; readings are held
 * in the service's own TTL cache and re-fetched when they age out.
 *
 * Exported so other modules (Sentinel's market-context layer, the assistant)
 * can read institutional flow and breadth through the same cached instance
 * rather than opening a second path to the exchange. One connector, one cache,
 * one set of cookies — a second caller fetching independently would double this
 * platform's request rate against a source that can refuse it.
 */
@Module({
  controllers: [NseController],
  providers: [NseService],
  exports: [NseService],
})
export class NseModule {}
