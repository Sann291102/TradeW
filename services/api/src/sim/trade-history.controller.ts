import { applyDecorators, Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { TradeHistoryFilters, TradeHistoryService } from './trade-history.service';

/**
 * Both routes take the same filters through a catch-all `@Query()` record,
 * which carries no per-parameter type information for the generated API
 * reference to read. Declared once here rather than repeated on each handler.
 */
const ApiTradeHistoryFilters = () =>
  applyDecorators(
    ApiQuery({ name: 'from', required: false, description: 'Inclusive start date (ISO). Ignored if unparseable.', example: '2026-01-01' }),
    ApiQuery({ name: 'to', required: false, description: 'Inclusive end date (ISO). Ignored if unparseable.', example: '2026-12-31' }),
    ApiQuery({ name: 'symbol', required: false, description: 'Exact instrument symbol.', example: 'NIFTY' }),
    ApiQuery({ name: 'search', required: false, description: 'Free-text match across the trade row.' }),
    ApiQuery({ name: 'page', required: false, type: Number, example: 1 }),
    ApiQuery({ name: 'pageSize', required: false, type: Number, example: 50 }),
  );

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
@ApiTags('Trade History')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('sim')
export class TradeHistoryController {
  constructor(private readonly tradeHistory: TradeHistoryService) {}

  /** Paged, filterable trade log for the caller. */
  @ApiTradeHistoryFilters()
  @Get('trade-history')
  list(@Req() req: any, @Query() query: Record<string, string | undefined>) {
    return this.tradeHistory.list(req.user.sub, parseFilters(query));
  }

  /** The same rows as `GET /sim/trade-history`, as a CSV download. */
  @ApiTradeHistoryFilters()
  @Get('trade-history/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="trade-history.csv"')
  async export(@Req() req: any, @Query() query: Record<string, string | undefined>) {
    return this.tradeHistory.exportCsv(req.user.sub, parseFilters(query));
  }
}
