import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { PUBLIC_PROXY_LIMIT } from '../common/throttling';
import { ForexService } from './forex.service';

/**
 * Foreign exchange market data (Twelve Data). Read-only — no order route; see
 * ForexService for why FX is not placeable yet.
 *
 * Pair symbols contain a slash ('EUR/USD'), which cannot go in a path segment,
 * so the candles route takes the pair as a query parameter rather than a param.
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
// See CryptoController: metered for this service's availability, not the vendor's.
@Throttle(PUBLIC_PROXY_LIMIT)
@ApiTags('Forex')
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
