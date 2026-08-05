import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TradeHistoryFilters, TradeHistoryService } from './trade-history.service';

/** Parses the shared query params both routes below accept. Empty/missing
 *  values are simply omitted rather than passed through as invalid dates —
 *  an unparsable `from`/`to` is treated as "no filter" rather than a 400,
 *  matching how the rest of this controller favors a working response over
 *  a strict-but-brittle one for read endpoints. */
function parseFilters(query: Record<string, string | undefined>): TradeHistoryFilters {
  const from = query.from ? new Date(query.from) : undefined;
  const to = query.to ? new Date(query.to) : undefined;
  return {
    from: from && !Number.isNaN(from.getTime()) ? from : undefined,
    to: to && !Number.isNaN(to.getTime()) ? to : undefined,
    symbol: query.symbol || undefined,
    search: query.search || undefined,
    page: query.page ? Number(query.page) : undefined,
    pageSize: query.pageSize ? Number(query.pageSize) : undefined,
  };
}

/** Same `/sim` prefix as the rest of the OMS — see HoldingsController for
 *  why a dedicated controller rather than growing SimController further. */
@UseGuards(AuthGuard)
@Controller('sim')
export class TradeHistoryController {
  constructor(private readonly tradeHistory: TradeHistoryService) {}

  @Get('trade-history')
  list(@Req() req: any, @Query() query: Record<string, string | undefined>) {
    return this.tradeHistory.list(req.user.sub, parseFilters(query));
  }

  @Get('trade-history/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="trade-history.csv"')
  async export(@Req() req: any, @Query() query: Record<string, string | undefined>) {
    return this.tradeHistory.exportCsv(req.user.sub, parseFilters(query));
  }
}
