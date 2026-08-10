import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { HoldingsService } from './holdings.service';

class SellHoldingDto {
  @ApiProperty({ minimum: 1, description: 'Units to sell from the settled holding.', example: 10 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Settled CNC equity — separate from `SimController`'s Positions/Orders
 * routes because Holdings is a distinct life stage (see HoldingsService /
 * SettlementService), not just another position filter. Same `/sim` prefix
 * as the rest of the OMS — Nest allows multiple controllers sharing one
 * path prefix — so the frontend's existing `/sim/*` client convention holds.
 */
@ApiTags('Holdings')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('sim')
export class HoldingsController {
  constructor(private readonly holdings: HoldingsService) {}

  @Get('holdings')
  list(@Req() req: any) {
    return this.holdings.list(req.user.sub);
  }

  @Post('holdings/:instrumentId/sell')
  sell(@Req() req: any, @Param('instrumentId') instrumentId: string, @Body() dto: SellHoldingDto) {
    return this.holdings.sell(req.user.sub, instrumentId, dto.quantity);
  }
}
