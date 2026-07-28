import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { StocksService } from './stocks.service';

/**
 * US equity market data (Twelve Data). Read-only — see StocksService for why
 * these are not placeable in a rupee-denominated paper account.
 *
 * Routed under /us-stocks rather than /stocks so it can never be confused with
 * the Indian equity surface, which is served by Dhan through /market-data.
 */
@UseGuards(AuthGuard)
@Controller('us-stocks')
export class StocksController {
  constructor(private readonly stocks: StocksService) {}

  /** GET /us-stocks/quotes[?symbols=AAPL,MSFT] — one batched upstream call. */
  @Get('quotes')
  quotes(@Query('symbols') symbols?: string) {
    const list = (symbols ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return this.stocks.quotes(list);
  }

  /** GET /us-stocks/candles?symbol=AAPL&interval=1d&outputsize=300 */
  @Get('candles')
  candles(
    @Query('symbol') symbol: string,
    @Query('interval') interval?: string,
    @Query('outputsize') outputsize?: string,
  ) {
    const bars = Number(outputsize);
    return this.stocks.candles(symbol, interval ?? '1d', Number.isFinite(bars) && bars > 0 ? bars : 300);
  }
}
