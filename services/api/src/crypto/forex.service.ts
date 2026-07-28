import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { CandleInterval } from '@tradew/types';
import { FxDataUnavailableError, FxQuote, fetchFxCandles, fetchFxQuotes } from '@tradew/market-data';

/**
 * Foreign exchange — real interbank spot from Twelve Data.
 *
 * DISPLAY ONLY, for the same reason as crypto: spot FX is quoted in fractional
 * units with 4-5 decimal places, and the OMS stores `quantity` as an `Int` and
 * prices as `Decimal(12,2)`. EUR/USD at 1.13703 would round to 1.14 and the
 * smallest order would be one whole unit. Trading FX needs the same schema
 * widening crypto does, sequenced after the money path has tests.
 *
 * The vendor key never reaches the browser: the client calls services/api and
 * this service holds TWELVEDATA_API_KEY server-side.
 */

/** The default board — the majors, plus USD/INR as the home-currency pair. */
export const DEFAULT_FX_PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/INR',
  'AUD/USD',
  'USD/CHF',
  'USD/CAD',
  'NZD/USD',
] as const;

const VALID_INTERVALS: readonly CandleInterval[] = ['1m', '5m', '15m', '1h', '1d'];

@Injectable()
export class ForexService {
  private readonly logger = new Logger(ForexService.name);

  /**
   * The live board. Always one batched upstream request regardless of how many
   * pairs are asked for — the free tier allows 8 requests/minute, so per-pair
   * fetching would exhaust the budget on a single page load.
   */
  async quotes(pairs?: string[]): Promise<FxQuote[]> {
    const wanted = pairs?.length ? pairs : [...DEFAULT_FX_PAIRS];
    return this.guard(() => fetchFxQuotes(wanted), 'quotes');
  }

  async candles(symbol: string, interval: string, outputsize: number) {
    const resolved = (VALID_INTERVALS as readonly string[]).includes(interval)
      ? (interval as CandleInterval)
      : '15m';
    const candles = await this.guard(() => fetchFxCandles(symbol, resolved, outputsize), `candles ${symbol}`);
    return { symbol, interval: resolved, source: 'twelvedata' as const, candles };
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
