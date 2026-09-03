import type { CandleInterval } from '@tradew/types';

/**
 * The canonical instrument reference — one shape for every venue TradeW knows.
 *
 * ── WHY THIS TYPE EXISTS ───────────────────────────────────────────────────
 *
 * Before this file, TradeW had four independent ideas of "what instruments
 * exist", none of which agreed and none of which covered crypto:
 *
 *   1. `lib/assistant/instruments.ts` — SYMBOL_UNIVERSE, assembled from the NSE
 *      mock sources. This is the one the assistant used, which is why
 *      "open BTC chart" resolved to nothing at all.
 *   2. `lib/search/providers.ts` — the command palette's own universe.
 *   3. `services/api/src/instruments` — the Prisma `Instrument` table, whose
 *      `InstrumentType` enum has four values, none of them crypto or forex.
 *   4. `services/api/src/ai/market/market-context.service.ts` — a fifth alias
 *      table layered over the same NSE rows.
 *
 * Crypto and FX sat outside all four, in hardcoded arrays inside
 * `services/api/src/crypto`. So "open crypto" was not a routing bug or a
 * permissions bug: a crypto pair was not a thing this application could name.
 *
 * ── THE FOUR CAPABILITY FIELDS ARE THE POINT ───────────────────────────────
 *
 * `quoteSource`, `candleSource`, `chartSurface` and `supportedIntervals` exist
 * so the assistant can know whether a request is satisfiable BEFORE it acts.
 * The old failure mode was arriving somewhere it could not operate and
 * reporting success anyway — "Opened /trade" written into the trace before
 * `router.push` had run. An agent that can read these fields can say "I can
 * show you EUR/USD, but our native chart has no bars for it" instead.
 */

/** What kind of thing this is. Drives labelling, not capability — capability
 *  is declared explicitly below, because two crypto pairs can differ. */
export type AssetClass =
  | 'index'
  | 'equity'
  | 'option'
  | 'future'
  | 'crypto'
  | 'forex'
  | 'commodity';

/** Where it trades. `BINANCE` and `TWELVEDATA` are data venues rather than
 *  exchanges TradeW routes to — which is exactly why `tradeable` is separate. */
export type Venue = 'NSE' | 'BSE' | 'MCX' | 'BINANCE' | 'TWELVEDATA';

/** Which backend serves a last price for this instrument. */
export type QuoteSource = 'dhan' | 'binance' | 'twelvedata' | 'simulated' | null;

/**
 * Which backend serves OHLCV bars.
 *
 * `null` means no candle feed exists, and the honest consequence is that the
 * native chart cannot draw this instrument at all — not that it draws an empty
 * one. See the 2026-07-26 no-fabricated-data rule in `useCandles`.
 */
export type CandleSource = 'dhan' | 'binance' | 'twelvedata' | null;

/**
 * Which surface can render this instrument.
 *
 *  - `native` — our own `TradeChart` (lightweight-charts). Drawings, detectors,
 *    structure studies and timeframe control all work.
 *  - `embed`  — a third-party TradingView iframe. Renders, but the assistant
 *    has no hands inside it: it cannot set a timeframe, read the series, or
 *    draw a zone. Anything promising those on an `embed` instrument is a lie.
 *  - `none`   — nothing can chart it.
 */
export type ChartSurface = 'native' | 'embed' | 'none';

export interface InstrumentRef {
  /** Platform-canonical symbol. Uppercase. Unique within the catalog. */
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  venue: Venue;
  /**
   * Spoken and typed forms that are not the symbol — "bitcoin", "bank nifty",
   * "eur usd". Matched longest-first so "bank nifty" cannot resolve as "nifty".
   *
   * These also feed the assistant's deterministic grammar, so adding an alias
   * here is how a new way of naming an instrument becomes understood, with no
   * change to the resolver, the validators or the prompt.
   */
  aliases: string[];

  quoteSource: QuoteSource;
  candleSource: CandleSource;
  chartSurface: ChartSurface;
  supportedIntervals: CandleInterval[];
  /**
   * Whether an order can be placed against it at all.
   *
   * Crypto is deliberately `false`: `Order.quantity` is an `Int` and every
   * price column is `Decimal(12,2)`, so the smallest possible crypto order
   * would be one whole BTC and any asset under ₹0.01 would round to zero (see
   * `services/api/src/crypto/crypto.service.ts`). The assistant reads this so
   * it never offers what the OMS cannot do.
   */
  tradeable: boolean;
}

/** Every interval the Dhan, Binance and Twelve Data candle routes all accept. */
export const COMMON_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '1d'];
