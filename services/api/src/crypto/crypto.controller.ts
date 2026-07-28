import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CryptoService } from './crypto.service';

/**
 * Crypto market data (Binance). Read-only — there is deliberately no order
 * route here; see CryptoService for why crypto is not placeable yet.
 *
 * Authenticated like every other market-data surface, but not entitlement-
 * gated: this is base market data, not premium intelligence.
 */
@UseGuards(AuthGuard)
@Controller('crypto')
export class CryptoController {
  constructor(private readonly crypto: CryptoService) {}

  /** GET /crypto/quotes[?symbols=BTCUSDT,ETHUSDT] — the live board. */
  @Get('quotes')
  quotes(@Query('symbols') symbols?: string) {
    const list = (symbols ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return this.crypto.quotes(list);
  }

  /**
   * GET /crypto/fx — Binance's only FX-like pair (EUR/USDT).
   *
   * Separate route rather than folded into /quotes so the client cannot render
   * it on the crypto board by accident: it needs its own caveat, because
   * Binance lists no true fiat/fiat pair and this is a stablecoin proxy.
   */
  @Get('fx')
  fx() {
    return this.crypto.fxProxyQuotes();
  }

  /** GET /crypto/candles/BTCUSDT?interval=15m&limit=500 — real OHLCV. */
  @Get('candles/:symbol')
  candles(
    @Param('symbol') symbol: string,
    @Query('interval') interval?: string,
    @Query('limit') limit?: string,
  ) {
    const bars = Number(limit);
    return this.crypto.candles(symbol, interval ?? '15m', Number.isFinite(bars) && bars > 0 ? bars : 500);
  }
}
