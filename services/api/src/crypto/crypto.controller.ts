import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CryptoService } from './crypto.service';

/**
 * Crypto market data (Binance). Read-only — there is deliberately no order
 * route here; see CryptoService for why crypto is not placeable yet.
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
@ApiTags('Crypto')
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
