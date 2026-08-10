import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { OrderSide, OrderStatus, OrderType, OrderValidity, ProductType } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { OrderService } from './order.service';
import { PositionService } from './position.service';
import { PortfolioService } from './portfolio.service';

/**
 * The `@ApiProperty` decorators below are written by hand rather than inferred.
 *
 * The `@nestjs/swagger` CLI plugin can only apply ONE of its two visitors per
 * file (it dispatches on filename and returns early — see its compiler-plugin
 * source), and every DTO in this codebase lives inside its controller file. The
 * project takes the controller visitor, which turns these docstrings into the
 * summary text on all ~138 operations; the cost is that DTO properties in these
 * files are not auto-derived. That is the better half of the trade, and it also
 * lets the Prisma enums below be documented as real enums — the plugin renders
 * an imported enum type as a bare `object`, which tells a caller nothing about
 * which values an order will actually accept.
 */
class ConvertPositionDto {
  @ApiProperty({ enum: ProductType, description: 'Product type to convert from.' })
  @IsEnum(ProductType)
  from!: ProductType;

  @ApiProperty({ enum: ProductType, description: 'Product type to convert to.' })
  @IsEnum(ProductType)
  to!: ProductType;
}

class PlaceOrderDto {
  @ApiProperty({ description: 'Instrument symbol.', example: 'RELIANCE' })
  @IsString()
  symbol!: string;

  @ApiProperty({ enum: OrderSide })
  @IsEnum(OrderSide)
  side!: OrderSide;

  @ApiProperty({ enum: OrderType, description: 'MARKET, LIMIT, SL or SL_M. Decides which prices below are required.' })
  @IsEnum(OrderType)
  type!: OrderType;

  @ApiProperty({ minimum: 1, description: 'Whole units. Lot sizing is applied server-side.', example: 10 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ enum: ProductType, required: false, default: 'MIS' })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiProperty({ enum: OrderValidity, required: false })
  @IsOptional()
  @IsEnum(OrderValidity)
  validity?: OrderValidity;

  /** Required for LIMIT and SL. */
  @ApiProperty({ required: false, minimum: 0.01, description: 'Required for LIMIT and SL.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  price?: number;

  /** Required for SL and SL_M. */
  @ApiProperty({ required: false, minimum: 0.01, description: 'Required for SL and SL_M.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  triggerPrice?: number;

  /**
   * Discipline override, sent only on a retry after the friction prompt.
   * Both are validated by `DisciplineService` (signature, single use,
   * mandatory dwell, reason quality), not here — these decorators only keep
   * `ValidationPipe({ whitelist: true })` from stripping them off the body.
   */
  @ApiProperty({
    required: false,
    description: 'Discipline override, sent only on a retry after the friction prompt. Validated by DisciplineService.',
  })
  @IsOptional()
  @IsString()
  overrideToken?: string;

  @ApiProperty({ required: false, description: 'The trader’s stated reason for overriding their own limit.' })
  @IsOptional()
  @IsString()
  overrideReason?: string;
}

class ModifyOrderDto {
  @ApiProperty({ required: false, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiProperty({ required: false, minimum: 0.01 })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  price?: number;

  @ApiProperty({ required: false, minimum: 0.01 })
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
@ApiTags('Trading')
@ApiBearerAuth(SECURITY.bearer)
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

  /** The order book. `status` accepts a comma-separated list, e.g. `OPEN,PENDING`. */
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Comma-separated OrderStatus filter. Omit for every order.',
    example: 'OPEN,COMPLETE',
  })
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

  @Get('positions/:instrumentId/convert-preview')
  previewConvert(
    @Req() req: any,
    @Param('instrumentId') instrumentId: string,
    @Query('from') from: ProductType,
    @Query('to') to: ProductType,
  ) {
    return this.positionService.previewConvert(req.user.sub, instrumentId, from, to);
  }

  @Post('positions/:instrumentId/convert')
  convert(@Req() req: any, @Param('instrumentId') instrumentId: string, @Body() dto: ConvertPositionDto) {
    return this.positionService.convert(req.user.sub, instrumentId, dto.from, dto.to);
  }

  @Get('portfolio')
  portfolio(@Req() req: any) {
    return this.portfolioService.summary(req.user.sub);
  }
}
