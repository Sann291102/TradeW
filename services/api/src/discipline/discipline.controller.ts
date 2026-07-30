import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
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
  @IsInt()
  @Min(LIMIT_BOUNDS.maxMinutes.min)
  @Max(LIMIT_BOUNDS.maxMinutes.max)
  maxMinutes!: number;

  @IsInt()
  @Min(LIMIT_BOUNDS.maxTrades.min)
  @Max(LIMIT_BOUNDS.maxTrades.max)
  maxTrades!: number;

  @IsNumber()
  @Min(LIMIT_BOUNDS.maxLoss.min)
  @Max(LIMIT_BOUNDS.maxLoss.max)
  maxLoss!: number;

  /** Optional by design — the panel advises it and never blocks on it. */
  @IsOptional()
  @IsNumber()
  @Min(LIMIT_BOUNDS.targetProfit.min)
  @Max(LIMIT_BOUNDS.targetProfit.max)
  targetProfit?: number;
}

class OverrideHistoryQuery {
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
