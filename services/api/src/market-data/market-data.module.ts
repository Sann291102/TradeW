import { Module } from '@nestjs/common';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { SimulatedEngineService } from './simulated-engine.service';

@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService, SimulatedEngineService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
