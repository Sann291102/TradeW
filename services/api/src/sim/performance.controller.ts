import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { MonthlyReturnsRange, PerformanceService, PortfolioValueRange } from './performance.service';

const VALUE_RANGES: PortfolioValueRange[] = ['1W', '1M', '3M', '1Y', 'ALL'];
const RETURN_RANGES: MonthlyReturnsRange[] = ['3M', '6M', '1Y'];

function parseValueRange(range: string | undefined): PortfolioValueRange {
  return (VALUE_RANGES as string[]).includes(range ?? '') ? (range as PortfolioValueRange) : '1M';
}
function parseReturnsRange(range: string | undefined): MonthlyReturnsRange {
  return (RETURN_RANGES as string[]).includes(range ?? '') ? (range as MonthlyReturnsRange) : '6M';
}

/**
 * Same `/sim` prefix as the rest of the OMS — see HoldingsController for why
 * a dedicated controller. No route here serves a '1D' range: there is no
 * intraday history store (see PerformanceService's docstring) — the 1D chart
 * is built client-side from the page's own live poll, not from an endpoint.
 */
@UseGuards(AuthGuard)
@Controller('sim')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get('performance/overview')
  overview(@Req() req: any) {
    return this.performance.overview(req.user.sub);
  }

  @Get('performance/today')
  today(@Req() req: any) {
    return this.performance.today(req.user.sub);
  }

  @Get('performance/portfolio-value')
  portfolioValue(@Req() req: any, @Query('range') range?: string) {
    return this.performance.portfolioValueSeries(req.user.sub, parseValueRange(range));
  }

  @Get('performance/daily-pnl')
  dailyPnl(@Req() req: any, @Query('range') range?: string) {
    return this.performance.dailyPnl(req.user.sub, parseValueRange(range));
  }

  @Get('performance/monthly-returns')
  monthlyReturns(@Req() req: any, @Query('range') range?: string) {
    return this.performance.monthlyReturns(req.user.sub, parseReturnsRange(range));
  }

  @Get('performance/diary')
  diary(@Req() req: any, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.performance.diary(req.user.sub, page ? Number(page) : 1, pageSize ? Number(pageSize) : 30);
  }
}
