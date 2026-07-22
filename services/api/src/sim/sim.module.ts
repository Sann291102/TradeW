import { Module } from '@nestjs/common';
import { SimController } from './sim.controller';
import { MarketPriceService } from './market-price.service';
import { OrderService } from './order.service';
import { MatchingEngineService } from './matching-engine.service';
import { PositionService } from './position.service';
import { PortfolioService } from './portfolio.service';

/**
 * Paper Trading OMS. `MarketDataModule` is no longer imported here — the OMS
 * prices every fill from the live Dhan bridge (`MarketPriceService`), not
 * Postgres's `Quote` table, so it no longer depends on that module. See
 * `MarketPriceService`'s docstring for why.
 */
@Module({
  controllers: [SimController],
  providers: [MarketPriceService, OrderService, MatchingEngineService, PositionService, PortfolioService],
})
export class SimModule {}
