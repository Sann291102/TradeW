import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StocksService } from './stocks.service';

/**
 * US equity market data (Twelve Data). Read-only — see StocksService for why
 * these are not placeable in a rupee-denominated paper account.
 *
 * Routed under /us-stocks rather than /stocks so it can never be confused with
 * the Indian equity surface, which is served by Dhan through /market-data.
 */
/**
 * PUBLIC — no AuthGuard.
 *
 * This is read-only public market data: no user scoping, no account state,
 * nothing that varies by who is asking. It was auth-gated while the Dhan feed
 * (Indian quotes, charts, option chain) was already fully public through the
 * bridge, so a signed-out visitor saw live NIFTY prices but "Missing bearer
 * token" on crypto and news. That was an inconsistency, not a security
 * boundary — anyone can read these numbers from Binance, the newswires or the
 * vendor directly.
 *
 * Everything user-scoped (orders, positions, wallet, discipline) stays behind
 * AuthGuard. Vendor quota is protected by the server-side cache, not by auth:
 * upstream cost is a function of time, not of how many callers there are.
 */
@ApiTags('US Stocks')
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
