import { Module } from '@nestjs/common';
import { DisciplineModule } from '../discipline/discipline.module';
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
 *
 * `DisciplineModule` is imported because the self-imposed session limits are
 * enforced on the order-placement path (`OrderService.placeOrder`), not in the
 * UI — so they bind any client that reaches `/sim/orders`, not just the web app.
 */
@Module({
  imports: [DisciplineModule],
  controllers: [SimController],
  providers: [MarketPriceService, OrderService, MatchingEngineService, PositionService, PortfolioService],
})
export class SimModule {}
