import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { CandleInterval } from '@tradew/types';
import { FxDataUnavailableError, StockQuote, fetchFxCandles, fetchStockQuotes } from '@tradew/market-data';

/**
 * US-listed equities — Twelve Data.
 *
 * The one asset class this vendor adds that the platform did not already have.
 * Indian equities and indices stay on Dhan: measured 2026-07-28, this plan
 * returns "available starting with the Grow or Venture plan" for NSE symbols
 * and does not recognise NIFTY 50 at all, while Dhan already serves both in
 * more depth and without a per-minute quota.
 *
 * DISPLAY ONLY. US equities settle in USD and the paper OMS is rupee-
 * denominated end to end — the wallet, margin model and P&L all assume INR, and
 * there is no FX conversion anywhere in that path. Quoting them is honest;
 * letting someone "buy" one with rupees at the raw USD figure would not be.
 */

/** A recognisable default board rather than an arbitrary list. */
export const DEFAULT_US_SYMBOLS = [
  'AAPL',
  'MSFT',
  'NVDA',
  'GOOGL',
  'AMZN',
  'META',
  'TSLA',
  'NFLX',
] as const;

const VALID_INTERVALS: readonly CandleInterval[] = ['1m', '5m', '15m', '1h', '1d'];

@Injectable()
export class StocksService {
  private readonly logger = new Logger(StocksService.name);

  /** Batched into one upstream request — the free tier allows 8 per minute. */
  async quotes(symbols?: string[]): Promise<StockQuote[]> {
    const wanted = symbols?.length ? symbols : [...DEFAULT_US_SYMBOLS];
    return this.guard(() => fetchStockQuotes(wanted), 'quotes');
  }

  /**
   * Candles reuse the FX time-series fetcher: Twelve Data's `/time_series` is
   * the same endpoint and shape for every asset class, so a separate copy would
   * be duplication, not separation. Volume reads 0 for FX and real for equities
   * because that is what the vendor returns in each case.
   */
  async candles(symbol: string, interval: string, outputsize: number) {
    const resolved = (VALID_INTERVALS as readonly string[]).includes(interval)
      ? (interval as CandleInterval)
      : '1d';
    const candles = await this.guard(() => fetchFxCandles(symbol, resolved, outputsize), `candles ${symbol}`);
    return { symbol: symbol.toUpperCase(), interval: resolved, source: 'twelvedata' as const, candles };
  }

  private async guard<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FxDataUnavailableError) {
        this.logger.warn(`${what}: ${err.message}`);
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }
}
