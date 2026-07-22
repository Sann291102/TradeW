import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { OrderSide, OrderStatus, OrderType, OrderValidity, ProductType } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { OrderService } from './order.service';
import { PositionService } from './position.service';
import { PortfolioService } from './portfolio.service';

class PlaceOrderDto {
  @IsString()
  symbol!: string;

  @IsEnum(OrderSide)
  side!: OrderSide;

  @IsEnum(OrderType)
  type!: OrderType;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  @IsEnum(OrderValidity)
  validity?: OrderValidity;

  /** Required for LIMIT and SL. */
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  price?: number;

  /** Required for SL and SL_M. */
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  triggerPrice?: number;
}

class ModifyOrderDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  triggerPrice?: number;
}

/**
 * Paper Trading OMS — Phase 1 (backend foundation). Extends the original
 * market-order-only `sim` routes (see archive/README.md) into a full order
 * lifecycle: MARKET/LIMIT/SL/SL_M placement, modify, cancel, exit, plus the
 * order book / trade book / positions / portfolio reads a trading UI needs.
 * Prices come from the live Dhan bridge (MarketPriceService), not Postgres's
 * simulated Quote table — see that service's docstring for why.
 *
 * Known Phase 1 scope limit: order placement covers indices/stocks/ETFs/
 * commodities only. Option-contract orders (from the Option Chain) are
 * rejected with a clear message (MarketPriceService.getPrice) — wiring that
 * needs the bridge to expose per-leg security ids, a follow-up phase.
 */
@UseGuards(AuthGuard)
@Controller('sim')
export class SimController {
  constructor(
    private readonly orderService: OrderService,
    private readonly positionService: PositionService,
    private readonly portfolioService: PortfolioService,
  ) {}

  @Post('orders')
  place(@Req() req: any, @Body() dto: PlaceOrderDto) {
    return this.orderService.placeOrder(req.user.sub, dto);
  }

  @Get('orders')
  orders(@Req() req: any, @Query('status') status?: string) {
    const filter = status
      ? (status
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean) as OrderStatus[])
      : undefined;
    return this.orderService.orderBook(req.user.sub, filter);
  }

  @Patch('orders/:id')
  modify(@Req() req: any, @Param('id') id: string, @Body() dto: ModifyOrderDto) {
    return this.orderService.modifyOrder(req.user.sub, id, dto);
  }

  @Delete('orders/:id')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.orderService.cancelOrder(req.user.sub, id);
  }

  @Get('trades')
  trades(@Req() req: any) {
    return this.orderService.tradeBook(req.user.sub);
  }

  @Get('positions')
  positions(@Req() req: any) {
    return this.positionService.list(req.user.sub);
  }

  // Static segments ('closed', 'exit-all') must be declared before the
  // dynamic ':instrumentId/exit' route below, or Nest/Express would try to
  // match them as an instrumentId instead.
  @Get('positions/closed')
  closedPositions(@Req() req: any) {
    return this.positionService.closed(req.user.sub);
  }

  @Post('positions/exit-all')
  exitAll(@Req() req: any) {
    return this.orderService.exitAll(req.user.sub);
  }

  @Post('positions/:instrumentId/exit')
  exitOne(@Req() req: any, @Param('instrumentId') instrumentId: string, @Query('productType') productType?: ProductType) {
    return this.orderService.exitPosition(req.user.sub, instrumentId, productType ?? 'MIS');
  }

  @Get('portfolio')
  portfolio(@Req() req: any) {
    return this.portfolioService.summary(req.user.sub);
  }
}
