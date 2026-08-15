import { Module } from '@nestjs/common';
import { DisciplineModule } from '../discipline/discipline.module';
import { NotificationModule } from '../notification/notification.module';
import { SimController } from './sim.controller';
import { HoldingsController } from './holdings.controller';
import { TradeHistoryController } from './trade-history.controller';
import { PerformanceController } from './performance.controller';
import { MarketPriceService } from './market-price.service';
import { OrderService } from './order.service';
import { MatchingEngineService } from './matching-engine.service';
import { PositionService } from './position.service';
import { PortfolioService } from './portfolio.service';
import { SettlementService } from './settlement.service';
import { HoldingsService } from './holdings.service';
import { TradeHistoryService } from './trade-history.service';
import { PerformanceService } from './performance.service';
import { EodSummaryService } from './eod-summary.service';

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
  imports: [DisciplineModule, NotificationModule],
  controllers: [SimController, HoldingsController, TradeHistoryController, PerformanceController],
  providers: [
    MarketPriceService,
    OrderService,
    MatchingEngineService,
    PositionService,
    PortfolioService,
    SettlementService,
    HoldingsService,
    TradeHistoryService,
    PerformanceService,
    EodSummaryService,
  ],
})
export class SimModule {}
