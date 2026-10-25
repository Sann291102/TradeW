/**
 * Crypto — Binance spot, through the client that already exists.
 *
 * ## Why this does not go through the bridge
 *
 * `GET :4600/candles?symbol=BTCUSDT` returns `{"candles":[],"source":"none"}`:
 * the bridge covers the Dhan universe and has no Binance integration at all.
 * The working client is `@tradew/market-data`'s
 * `providers/binance/binance.client`, already used by `services/api/src/crypto`
 * and verified live.
 *
 * So crypto reaches the decision core by a second transport. That is exactly
 * what the port exists for, and it is the whole extent of the difference —
 * the bars land in the same `MarketSnapshot` and are judged by the same rules.
 *
 * ## The two things crypto genuinely does differently
 *
 * `marketOpen` is always true (24/7, no session), and there is no venue
 * session clock — so the scanner passes a null IST minute and setups with an
 * `idealSession` simply do not apply rather than being refused for being
 * "out of hours" in a market that has none.
 */

import { Injectable } from '@nestjs/common';
import type { Candle, CandleInterval } from '@tradew/types';
import {
  CryptoDataUnavailableError,
  fetchCryptoCandles,
  fetchCryptoQuotes,
  type ExperimentMarket,
} from '@tradew/market-data';
import { MarketDataUnavailable, type MarketDataRead, type MarketDataSource } from './market-data.port';

/**
 * Bars per request.
 *
 * Binance caps a klines call at 1000. The feature core needs 50+ for its EMA
 * and the level layer wants a stable ATR, so several hundred is comfortable
 * without asking for the ceiling every scan.
 */
const BAR_LIMIT = 400;

@Injectable()
export class BinanceSource implements MarketDataSource {
  readonly id = 'binance';
  readonly markets: readonly ExperimentMarket[] = ['CRYPTO'];

  async read(symbol: string, interval: CandleInterval, _lookbackDays: number): Promise<MarketDataRead> {
    try {
      const [candles, quotes] = await Promise.all([
        fetchCryptoCandles(symbol, interval, BAR_LIMIT),
        fetchCryptoQuotes([symbol]),
      ]);

      const quote = quotes.find((q) => q.symbol?.toUpperCase() === symbol.toUpperCase()) ?? null;
      const newest = candles[candles.length - 1] ?? null;

      return {
        symbol,
        interval,
        // `fetchCryptoCandles` already returns `Candle[]` with real `Date`
        // timestamps, so there is nothing to normalise — re-mapping it would
        // only create a second place for the shape to drift.
        candles,
        lastPrice: quote?.ltp ?? null,
        // Binance's ticker carries its own clock; the newest bar is the
        // fallback so freshness is never silently unknown.
        lastDataAt: quote?.updatedAt
          ? new Date(quote.updatedAt)
          : newest
            ? new Date(newest.timestamp)
            : null,
        marketOpen: true,
        source: 'binance',
      };
    } catch (err) {
      // The client already distinguishes "the provider is unavailable" from
      // "this symbol has no data"; both become one fault here so the scanner
      // never confuses a Binance outage with a quiet market.
      const detail =
        err instanceof CryptoDataUnavailableError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      throw new MarketDataUnavailable(symbol, this.id, detail);
    }
  }
}
