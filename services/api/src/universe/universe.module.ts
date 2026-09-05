import { Module } from '@nestjs/common';
import { UniverseController } from './universe.controller';
import { UniverseService } from './universe.service';

/**
 * The tradable universe, read side.
 *
 * READS ONLY. The catalogue is built and refreshed by
 * `services/market-data` (UniverseSyncService) — a sync downloads ~15 MiB and
 * writes hundreds of thousands of rows, which is ingestion work and has no
 * business on an API request path. This module never writes to
 * `UniverseInstrument`.
 *
 * No PrismaModule import: it is @Global.
 */
@Module({
  controllers: [UniverseController],
  providers: [UniverseService],
  exports: [UniverseService],
})
export class UniverseModule {}
