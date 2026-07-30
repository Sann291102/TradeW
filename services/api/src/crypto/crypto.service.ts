import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { CandleInterval } from '@tradew/types';
import {
  CryptoDataUnavailableError,
  CryptoQuote,
  fetchCryptoCandles,
  fetchCryptoQuotes,
} from '@tradew/market-data';

/**
 * Crypto market data — real Binance prices, read-only.
 *
 * DISPLAY ONLY. Nothing here touches the OMS, and crypto is deliberately not
 * placeable: `Order.quantity` is an `Int` and every price column is
 * `Decimal(12,2)`, so the smallest possible crypto order would be 1 whole BTC
 * and any asset under ₹0.01 would round to zero. Making crypto tradeable means
 * widening those columns across Order/Trade/Position/Quote/Candle — the same
 * arithmetic that currently has no test coverage — so it is sequenced after
 * that work, not bolted on here.
 *
 * Provenance: every number is live Binance data. When Binance is unreachable
 * this raises 503 rather than serving a stale or simulated price, matching the
 * rule the Dhan path already follows.
 */

/** The default board. Majors first, then the large alts by market cap. */
export const DEFAULT_CRYPTO_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'TRXUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'MATICUSDT',
] as const;

/**
 * EUR/USDT — the closest thing Binance has to a foreign-exchange pair.
 *
 * Kept separate from the crypto board and labelled honestly by the UI: Binance
 * lists NO fiat/fiat pairs at all (verified against /api/v3/exchangeInfo,
 * 2026-07-28 — zero symbols where both base and quote are fiat), so this is EUR
 * priced in a US-dollar stablecoin, not an interbank FX rate. It must never be
 * presented as "EUR/USD".
 */
export const FX_PROXY_SYMBOLS = ['EURUSDT'] as const;

const VALID_INTERVALS: readonly CandleInterval[] = ['1m', '5m', '15m', '1h', '1d'];

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);

  /** Live board. `symbols` overrides the default set. */
  async quotes(symbols?: string[]): Promise<CryptoQuote[]> {
    const wanted = symbols?.length ? symbols : [...DEFAULT_CRYPTO_SYMBOLS];
    return this.guard(() => fetchCryptoQuotes(wanted), 'quotes');
  }

  /** The single FX-proxy pair, served separately so the UI can caveat it. */
  async fxProxyQuotes(): Promise<CryptoQuote[]> {
    return this.guard(() => fetchCryptoQuotes([...FX_PROXY_SYMBOLS]), 'fx quotes');
  }

  async candles(symbol: string, interval: string, limit: number) {
    const resolved = (VALID_INTERVALS as readonly string[]).includes(interval)
      ? (interval as CandleInterval)
      : '15m';
    const candles = await this.guard(() => fetchCryptoCandles(symbol, resolved, limit), `candles ${symbol}`);
    return { symbol: symbol.toUpperCase(), interval: resolved, source: 'binance' as const, candles };
  }

  /**
   * Maps the provider's unavailability into a 503 with its own message, so the
   * workspace can state what is disconnected instead of rendering an empty
   * chart that looks like a quiet market.
   */
  private async guard<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CryptoDataUnavailableError) {
        this.logger.warn(`${what}: ${err.message}`);
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }
}
