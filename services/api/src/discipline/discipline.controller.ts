import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { LIMIT_BOUNDS } from './discipline-limits';
import { DisciplineService } from './discipline.service';

type AuthedRequest = { user: { sub: string } };

/**
 * Bounds are declared twice on purpose: here as `class-validator` decorators
 * so a bad request is a 400 at the edge, and in `discipline-limits.ts` as the
 * pure `validateLimits` the service calls. The decorators are the HTTP
 * contract; `validateLimits` is the rule, and it stays testable without a
 * request. `LIMIT_BOUNDS` keeps the numbers themselves in one place.
 */
class StartSessionDto {
  @ApiProperty({ description: 'Minutes the trader allows themselves today.', minimum: LIMIT_BOUNDS.maxMinutes.min, maximum: LIMIT_BOUNDS.maxMinutes.max, example: 120 })
  @IsInt()
  @Min(LIMIT_BOUNDS.maxMinutes.min)
  @Max(LIMIT_BOUNDS.maxMinutes.max)
  maxMinutes!: number;

  @ApiProperty({ description: 'Maximum trades today.', minimum: LIMIT_BOUNDS.maxTrades.min, maximum: LIMIT_BOUNDS.maxTrades.max, example: 5 })
  @IsInt()
  @Min(LIMIT_BOUNDS.maxTrades.min)
  @Max(LIMIT_BOUNDS.maxTrades.max)
  maxTrades!: number;

  @ApiProperty({ description: 'Maximum loss today, in rupees.', minimum: LIMIT_BOUNDS.maxLoss.min, maximum: LIMIT_BOUNDS.maxLoss.max, example: 5000 })
  @IsNumber()
  @Min(LIMIT_BOUNDS.maxLoss.min)
  @Max(LIMIT_BOUNDS.maxLoss.max)
  maxLoss!: number;

  /** Optional by design — the panel advises it and never blocks on it. */
  @ApiProperty({ required: false, description: 'Advisory only — the panel never blocks on it.', minimum: LIMIT_BOUNDS.targetProfit.min, maximum: LIMIT_BOUNDS.targetProfit.max })
  @IsOptional()
  @IsNumber()
  @Min(LIMIT_BOUNDS.targetProfit.min)
  @Max(LIMIT_BOUNDS.targetProfit.max)
  targetProfit?: number;
}

class OverrideHistoryQuery {
  @ApiProperty({ required: false, enum: ['MAX_TRADES', 'MAX_LOSS', 'MAX_MINUTES'] })
  @IsOptional()
  @IsIn(['MAX_TRADES', 'MAX_LOSS', 'MAX_MINUTES'])
  limitType?: 'MAX_TRADES' | 'MAX_LOSS' | 'MAX_MINUTES';
}

/**
 * Discipline session — the trader's self-imposed limits for the trading day.
 *
 * Authenticated but deliberately NOT entitlement-gated. This is a safety
 * surface, not a premium one; putting it behind `@RequiresCapability` would
 * hide it from exactly the users who have no plan row yet.
 */
@ApiTags('Discipline')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('discipline')
export class DisciplineController {
  constructor(private readonly discipline: DisciplineService) {}

  /** Drives the blocking panel: whether to show it, and today's session if set. */
  @Get('today')
  today(@Req() req: AuthedRequest) {
    return this.discipline.today(req.user.sub);
  }

  /** The panel's submit. Idempotent — a double tap returns the same session. */
  @Post('today')
  start(@Req() req: AuthedRequest, @Body() dto: StartSessionDto) {
    return this.discipline.startSession(req.user.sub, {
      maxMinutes: dto.maxMinutes,
      maxTrades: dto.maxTrades,
      maxLoss: dto.maxLoss,
      targetProfit: dto.targetProfit ?? null,
    });
  }

  /**
   * Override history across dates — the behavioural record this feature
   * exists to build. Optional `limitType` filter hits the
   * `(userId, limitType, createdAt)` index directly.
   */
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive start date (ISO). Ignored if unparseable.', example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive end date (ISO). Ignored if unparseable.', example: '2026-12-31' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @Get('overrides')
  overrides(
    @Req() req: AuthedRequest,
    @Query() query: OverrideHistoryQuery,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.discipline.overrideHistory(req.user.sub, {
      limitType: query.limitType,
      from: parseDate(from),
      to: parseDate(to),
      limit: limit ? Number(limit) : undefined,
    });
  }
}

/** Ignores an unparseable date rather than 400-ing a history read over it. */
function parseDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
