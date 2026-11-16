/**
 * India (NSE) and Gold (MCX) — both served by the Dhan bridge on :4600.
 *
 * One source for two markets, deliberately: they differ in session hours and
 * in how a signal is EXPRESSED (an index option versus a futures lot), and in
 * nothing this file is responsible for. Both are Dhan instruments read through
 * the same two endpoints, so splitting them here would duplicate the transport
 * to encode a difference that lives in the execution adapter.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Candle, CandleInterval } from '@tradew/types';
import type { ExperimentMarket } from '@tradew/market-data';
import { MarketDataUnavailable, type MarketDataRead, type MarketDataSource } from './market-data.port';

const BRIDGE_URL = (process.env.DHAN_LIVE_URL || 'http://localhost:4600').replace(/\/$/, '');

/**
 * How long to wait on the bridge before giving up.
 *
 * A bare `fetch` with no signal lets a hung bridge hold this worker forever,
 * and the scanner runs on a timer — so in-flight calls would accumulate into a
 * slow resource leak rather than a visible failure. The 2026-08-17 audit
 * measured `/observe` at 54,984 ms for exactly this reason.
 */
const TIMEOUT_MS = 8_000;

interface BridgeCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BridgeCandleResponse {
  candles?: BridgeCandle[];
  source?: string;
  fault?: string;
  message?: string;
}

interface BridgeQuote {
  symbol: string;
  ltp: number;
  marketStatus?: 'open' | 'closed';
  updatedAt?: string;
}

@Injectable()
export class DhanBridgeSource implements MarketDataSource {
  readonly id = 'dhan-bridge';
  readonly markets: readonly ExperimentMarket[] = ['INDIA', 'GOLD'];

  private readonly logger = new Logger(DhanBridgeSource.name);

  async read(symbol: string, interval: CandleInterval, lookbackDays: number): Promise<MarketDataRead> {
    const [candles, quote] = await Promise.all([
      this.candles(symbol, interval, lookbackDays),
      this.quote(symbol),
    ]);

    return {
      symbol,
      interval,
      candles,
      lastPrice: quote?.ltp && quote.ltp > 0 ? quote.ltp : null,
      // The bridge's own tick clock, which answers "is the feed ALIVE?" rather
      // than "is the bridge REACHABLE?". Those are different questions, and
      // asking only the second is how a stopped tick map served 200s for a
      // whole session on 2026-08-17.
      lastDataAt: quote?.updatedAt ? new Date(quote.updatedAt) : null,
      marketOpen: quote?.marketStatus === 'open',
      source: 'dhan',
    };
  }

  private async candles(symbol: string, interval: CandleInterval, days: number): Promise<Candle[]> {
    // NOTE the parameter name: the bridge reads `interval`, NOT `timeframe`.
    // An unrecognised parameter is silently ignored and you are served the 5m
    // default, which looks exactly like "every timeframe returns the same
    // bars" and is a genuinely confusing hour to lose.
    const url = `${BRIDGE_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&days=${days}`;
    const body = await this.getJson<BridgeCandleResponse>(url, symbol);

    // `source: 'error'` is the bridge's way of saying it answered but the
    // upstream refused — HTTP 200 with a named fault. Treating that as "no
    // candles" would report a dead credential as a quiet market.
    if (body.source === 'error') {
      throw new MarketDataUnavailable(symbol, this.id, body.fault ?? body.message ?? 'upstream fault');
    }

    return (body.candles ?? []).map((c) => ({
      timestamp: new Date(c.timestamp),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  private async quote(symbol: string): Promise<BridgeQuote | null> {
    try {
      const body = await this.getJson<Record<string, unknown>>(
        `${BRIDGE_URL}/quotes?symbols=${encodeURIComponent(symbol)}`,
        symbol,
      );

      // The bridge buckets its response by asset class — `indices`, `stocks`,
      // `etfs`, `commodities` — so EVERY array is searched rather than a
      // hand-listed few. Naming them individually is how GOLD arrived with no
      // freshness signal at all: it sits in `commodities`, the list said
      // `indices`, and the miss looked identical to a quote the bridge simply
      // did not have. A bucket added later must not be able to do that again.
      const wanted = symbol.toUpperCase();
      for (const value of Object.values(body)) {
        if (!Array.isArray(value)) continue;
        const hit = (value as BridgeQuote[]).find((q) => q?.symbol?.toUpperCase() === wanted);
        if (hit) return hit;
      }
      return null;
    } catch (err) {
      // A missing quote degrades the read (no live price, no freshness) but
      // does not invalidate the bars, so it is logged and survived rather than
      // failing the whole scan. The freshness gate downstream will refuse on
      // a null `lastDataAt` anyway.
      this.logger.warn(`quote for ${symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async getJson<T>(url: string, symbol: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new MarketDataUnavailable(symbol, this.id, `bridge returned HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof MarketDataUnavailable) throw err;
      const detail = err instanceof Error && err.name === 'AbortError'
        ? `no response within ${TIMEOUT_MS} ms`
        : err instanceof Error ? err.message : String(err);
      throw new MarketDataUnavailable(symbol, this.id, detail);
    } finally {
      clearTimeout(timer);
    }
  }
}
