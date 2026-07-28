import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ForexService } from './forex.service';

/**
 * Foreign exchange market data (Twelve Data). Read-only — no order route; see
 * ForexService for why FX is not placeable yet.
 *
 * Pair symbols contain a slash ('EUR/USD'), which cannot go in a path segment,
 * so the candles route takes the pair as a query parameter rather than a param.
 */
@UseGuards(AuthGuard)
@Controller('forex')
export class ForexController {
  constructor(private readonly forex: ForexService) {}

  /** GET /forex/quotes[?pairs=EUR/USD,USD/INR] — one batched upstream call. */
  @Get('quotes')
  quotes(@Query('pairs') pairs?: string) {
    const list = (pairs ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return this.forex.quotes(list);
  }

  /** GET /forex/candles?symbol=EUR/USD&interval=15m&outputsize=300 */
  @Get('candles')
  candles(
    @Query('symbol') symbol: string,
    @Query('interval') interval?: string,
    @Query('outputsize') outputsize?: string,
  ) {
    const bars = Number(outputsize);
    return this.forex.candles(symbol, interval ?? '15m', Number.isFinite(bars) && bars > 0 ? bars : 300);
  }
}
