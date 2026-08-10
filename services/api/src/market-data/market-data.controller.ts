import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { MarketDataService } from './market-data.service';

@ApiTags('Market Data')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('market-data')
export class MarketDataController {
  constructor(private readonly marketData: MarketDataService) {}

  @Get('quote/:instrumentId')
  quote(@Param('instrumentId') instrumentId: string) {
    return this.marketData.quote(instrumentId);
  }

  /** GET /market-data/quote-by-symbol/NIFTY — symbol-keyed single quote. */
  @Get('quote-by-symbol/:symbol')
  quoteBySymbol(@Param('symbol') symbol: string) {
    return this.marketData.quoteBySymbol(symbol.toUpperCase());
  }

  /** GET /market-data/quotes?symbols=NIFTY,BANKNIFTY — batch quote read. */
  @Get('quotes')
  quotes(@Query('symbols') symbols?: string) {
    const list = (symbols ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    return this.marketData.quotesBySymbols(list);
  }

  /** GET /market-data/indices — the 5-index dashboard/ticker feed. */
  @Get('indices')
  indices() {
    return this.marketData.indices();
  }
}
