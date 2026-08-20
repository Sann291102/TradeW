import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BacktestStatus, OrderType, ProductType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { BacktestAnalysisService } from './backtest-analysis.service';
import { BacktestService } from './backtest.service';

/**
 * DTOs are declared ABOVE the controller, and must stay there.
 *
 * A DTO class below its controller is still in its temporal dead zone when
 * `emitDecoratorMetadata` evaluates `design:paramtypes` at class-definition
 * time, so the whole API dies at import with "Cannot access 'X' before
 * initialization" — while `tsc --noEmit` and every unit test pass, because
 * nothing but actually booting Nest instantiates the context. See
 * `knowledge/Gotchas/2026-08-12 - Nest DTOs must be declared above the controller`.
 *
 * The `@ApiProperty` decorators are hand-written for the reason `sim.controller`
 * records: the swagger CLI plugin applies only its controller visitor in this
 * codebase, so DTO properties are not auto-derived.
 */
class CreateBacktestDto {
  @ApiPropertyOptional({ description: 'A name for this run. Optional.' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({ description: 'Instrument symbol, e.g. NIFTY.', example: 'NIFTY' })
  @IsString()
  symbol!: string;

  @ApiPropertyOptional({ description: 'Exchange. Defaults to the instrument\'s own.', example: 'NSE' })
  @IsOptional()
  @IsString()
  exchange?: string;

  @ApiProperty({ description: 'Bar timeframe: 1m | 5m | 15m | 1h | 1d.', example: '15m' })
  @IsString()
  timeframe!: string;

  @ApiProperty({ description: 'Start of the historical window (ISO).' })
  @IsString()
  startAt!: string;

  @ApiProperty({ description: 'End of the historical window (ISO).' })
  @IsString()
  endAt!: string;

  @ApiPropertyOptional({ description: 'Strategy id, or omitted for any enabled strategy.' })
  @IsOptional()
  @IsString()
  strategyId?: string | null;

  @ApiPropertyOptional({ description: 'Confidence floor a detection must clear, 0-100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minConfidence?: number;

  @ApiPropertyOptional({ description: 'Score partially-confirmed setups too. Off by default.' })
  @IsOptional()
  @IsBoolean()
  includeUnvalidated?: boolean;

  @ApiPropertyOptional({ description: 'Take bearish signals as short entries.' })
  @IsOptional()
  @IsBoolean()
  allowShort?: boolean;

  @ApiPropertyOptional({ description: 'Starting capital in rupees.' })
  @IsOptional()
  @IsNumber()
  initialCapital?: number;

  @ApiPropertyOptional({ description: 'FIXED_QUANTITY | FIXED_LOTS | CAPITAL_PCT | RISK_PCT.' })
  @IsOptional()
  @IsString()
  sizingMode?: 'FIXED_QUANTITY' | 'FIXED_LOTS' | 'CAPITAL_PCT' | 'RISK_PCT';

  @ApiPropertyOptional({ description: 'Interpreted by sizingMode.' })
  @IsOptional()
  @IsNumber()
  sizingValue?: number;

  @ApiPropertyOptional({ enum: ProductType })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiPropertyOptional({ enum: OrderType })
  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  @ApiPropertyOptional({ description: 'Charges per leg as a fraction of traded value, e.g. 0.0003.' })
  @IsOptional()
  @IsNumber()
  feeRate?: number;

  @ApiPropertyOptional({ description: 'Modelled slippage as a fraction of price, charged on both legs.' })
  @IsOptional()
  @IsNumber()
  slippageRate?: number;

  @ApiPropertyOptional({ description: 'SIGNAL_BAR | PERCENT | NONE.' })
  @IsOptional()
  @IsString()
  stopMode?: 'SIGNAL_BAR' | 'PERCENT' | 'NONE';

  @ApiPropertyOptional({ description: 'Stop distance as a fraction of entry, when stopMode is PERCENT.' })
  @IsOptional()
  @IsNumber()
  stopPct?: number;

  @ApiPropertyOptional({ description: 'Target = entry + rewardRisk x risk.' })
  @IsOptional()
  @IsNumber()
  rewardRisk?: number;

  @ApiPropertyOptional({ description: 'Force-exit after N bars. 0 disables.' })
  @IsOptional()
  @IsInt()
  timeoutBars?: number;

  @ApiPropertyOptional({ description: 'Bars to stay flat after a trade closes.' })
  @IsOptional()
  @IsInt()
  cooldownBars?: number;

  @ApiPropertyOptional({ description: 'Concurrent positions allowed.' })
  @IsOptional()
  @IsInt()
  maxOpenPositions?: number;

  @ApiPropertyOptional({ description: 'Entries allowed per IST day.' })
  @IsOptional()
  @IsInt()
  maxOrdersPerDay?: number;

  @ApiPropertyOptional({ description: 'Positive rupees. A day below -this takes no more entries.' })
  @IsOptional()
  @IsNumber()
  maxLossPerDay?: number;

  @ApiPropertyOptional({ description: 'IST minute-of-day at which intraday positions are closed.' })
  @IsOptional()
  @IsInt()
  squareOffMinute?: number;

  @ApiPropertyOptional({ description: 'Close every position at the last bar of each session.' })
  @IsOptional()
  @IsBoolean()
  intradayOnly?: boolean;

  @ApiPropertyOptional({ description: 'Copy risk policy from one of your own execution profiles.' })
  @IsOptional()
  @IsString()
  sourceProfileId?: string;
}

class CompareBacktestsDto {
  @ApiProperty({ description: 'Two to six backtest ids, all your own.', type: [String] })
  @IsArray()
  @IsString({ each: true })
  ids!: string[];
}

interface AuthedRequest {
  user?: { sub?: string };
}

/**
 * The user's backtesting API.
 *
 * ## This is historical analysis, and it is not the paper engine
 *
 * Nothing here can place an order. `BacktestModule` imports no OMS service, and
 * the tables behind these endpoints have no column that could reference an
 * `Order` — see the schema note above the `Backtest` model. A backtest and a
 * paper trade are separate systems that happen to share arithmetic, which is
 * the only thing they should share.
 *
 * ## Every route is scoped to the caller
 *
 * `req.user.sub` is the only identity used, and it goes into the `where`
 * clause, not into a check afterwards. A row belonging to someone else is
 * reported as not found.
 */
@ApiTags('Backtesting')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('backtests')
export class BacktestController {
  constructor(
    private readonly backtests: BacktestService,
    private readonly analysis: BacktestAnalysisService,
  ) {}

  /** Queue a historical simulation. Returns immediately with a QUEUED row. */
  @Post()
  create(@Req() req: AuthedRequest, @Body() body: CreateBacktestDto) {
    return this.backtests.create(req.user!.sub!, body);
  }

  /** The caller's backtests, newest first. */
  @ApiQuery({ name: 'status', required: false, enum: BacktestStatus })
  @ApiQuery({ name: 'strategyId', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'timeframe', required: false })
  @ApiQuery({ name: 'profitable', required: false, description: 'true | false — completed runs only.' })
  @ApiQuery({ name: 'from', required: false, description: 'Created on or after (ISO).' })
  @ApiQuery({ name: 'to', required: false, description: 'Created on or before (ISO).' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('strategyId') strategyId?: string,
    @Query('symbol') symbol?: string,
    @Query('timeframe') timeframe?: string,
    @Query('profitable') profitable?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.backtests.list(req.user!.sub!, {
      status: status && status in BacktestStatus ? (status as BacktestStatus) : undefined,
      strategyId: strategyId || undefined,
      symbol: symbol || undefined,
      timeframe: timeframe || undefined,
      profitable: profitable === undefined || profitable === '' ? undefined : profitable === 'true',
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /**
   * Compare two to six of the caller's own results.
   *
   * A POST rather than a GET with repeated query parameters: the id list is the
   * request body's whole subject, and putting six uuids in a URL makes them
   * land in access logs for no benefit.
   */
  @Post('compare')
  compare(@Req() req: AuthedRequest, @Body() body: CompareBacktestsDto) {
    return this.backtests.compare(req.user!.sub!, body.ids);
  }

  /** One result, with its configuration, provenance and metrics. */
  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.backtests.get(req.user!.sub!, id);
  }

  /** Every simulated trade in the run. */
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @Get(':id/trades')
  trades(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.backtests.trades(req.user!.sub!, id, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /** The persisted equity curve, for the chart. */
  @Get(':id/equity')
  equity(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.backtests.equity(req.user!.sub!, id);
  }

  /** Stop a queued or running backtest. A finished one is left untouched. */
  @Post(':id/cancel')
  cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.backtests.cancel(req.user!.sub!, id);
  }

  /**
   * Generate (or return) the optional AI reading of a completed result.
   *
   * The model receives only the stored metrics — never the bars, never the
   * trade list — and its output is additive commentary that cannot alter the
   * result. See `BacktestAnalysisService`.
   */
  @Post(':id/analysis')
  analyse(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.analysis.generate(req.user!.sub!, id);
  }
}
