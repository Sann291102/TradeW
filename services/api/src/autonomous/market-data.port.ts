/**
 * The market-data port — the ONE thing that differs between markets.
 *
 *     Market Data  →  Feature Core  →  Setup Engine  →  Level Deriver
 *          ↑
 *      this file
 *
 * ## Why a port and not a branch
 *
 * India and Gold are served by the Dhan bridge; crypto is served by Binance's
 * REST API through a client that already exists. Those are genuinely different
 * transports with different rate limits and different session semantics — and
 * that difference is the ONLY one the autonomous engine is allowed to have.
 * Everything above this line reads a `MarketSnapshot` and cannot tell which
 * source produced it.
 *
 * The alternative — a `if (market === 'CRYPTO')` inside the scanner — is what
 * produces a second strategy implementation by accident: the branch starts as
 * a data detail and, one bug fix at a time, becomes a different decision path.
 *
 * ## What a source owes its caller
 *
 * Bars, a spot price, and an honest statement of freshness. Nothing else. A
 * source must NEVER return an empty bar array to mean "the fetch failed" —
 * that is the exact confusion the 2026-08-17 incident was made of, where a
 * refused credential was reported as facts about the market ("no candles
 * exist" when 1,627 existed). Absence and fault get separate representations
 * here and the scanner reports them differently.
 */

import type { Candle, CandleInterval } from '@tradew/types';
import type { ExperimentMarket } from '@tradew/market-data';

/** What one source returns for one instrument. */
export interface MarketDataRead {
  symbol: string;
  interval: CandleInterval;
  /** Newest last. May include the still-forming bar — the feature core splits it. */
  candles: Candle[];
  /** Live last-traded price, when the source can give one separately from the bars. */
  lastPrice: number | null;
  /** When the venue last produced data, per the source. Null when unknowable. */
  lastDataAt: Date | null;
  /** Whether the venue is currently trading, per the source. */
  marketOpen: boolean;
  /** For the audit trail — 'dhan', 'binance'. */
  source: string;
}

/**
 * A fault, kept distinct from an empty result.
 *
 * `MarketDataUnavailable` means WE could not find out. An empty `candles` array
 * on a successful read would mean the venue genuinely has no history. Callers
 * must be able to tell those apart, because the first is an outage to report
 * and the second is a market to skip.
 */
export class MarketDataUnavailable extends Error {
  constructor(
    readonly symbol: string,
    readonly source: string,
    message: string,
  ) {
    super(`${source} could not serve ${symbol}: ${message}`);
    this.name = 'MarketDataUnavailable';
  }
}

export interface MarketDataSource {
  /** 'dhan-bridge' | 'binance'. Recorded on every candidate. */
  readonly id: string;
  /** Which markets this source is authoritative for. */
  readonly markets: readonly ExperimentMarket[];
  /**
   * Fetch bars for one symbol.
   *
   * Throws `MarketDataUnavailable` on a fault. Returning a short or empty
   * series is legal and means exactly that.
   */
  read(symbol: string, interval: CandleInterval, lookbackDays: number): Promise<MarketDataRead>;
}
