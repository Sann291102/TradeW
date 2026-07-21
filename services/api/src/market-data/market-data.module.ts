import { Module } from '@nestjs/common';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';

/**
 * Read-only market data.
 *
 * `SimulatedEngineService` is deliberately absent: the API no longer generates
 * market data at request time. The simulated market still exists — it moved to
 * `@tradew/market-data` and is driven by the `services/market-data` ingestor,
 * which is the only writer of `Quote`. The original file is preserved at
 * `archive/api-market-data-simulated-engine.service.ts.txt` per CLAUDE.md Rule 1.
 */
@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
