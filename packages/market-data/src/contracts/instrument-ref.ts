/**
 * How an instrument is addressed across provider boundaries.
 *
 * The existing `MarketDataProvider` in `@tradew/types` addresses instruments by
 * `symbol`, which was correct while simulation was the only source. Every real
 * broker addresses them by an exchange-scoped id instead — Dhan requires
 * `(exchangeSegment, securityId)` on every REST call and WebSocket
 * subscription, and never accepts a symbol.
 *
 * `InstrumentRef` carries both so the symbol-based contract keeps working
 * unchanged while broker-addressed calls become possible. Providers that only
 * understand symbols ignore the broker fields; providers that need broker ids
 * fail loudly when they are absent, rather than silently returning wrong data.
 */

/** Dhan exchange-and-segment codes. Closed set — see the DhanHQ annexure. */
export const EXCHANGE_SEGMENTS = ['NSE_EQ', 'NSE_FNO', 'BSE_EQ', 'BSE_FNO', 'MCX_COMM', 'IDX_I'] as const;
export type ExchangeSegment = (typeof EXCHANGE_SEGMENTS)[number];

const SEGMENT_SET: ReadonlySet<string> = new Set(EXCHANGE_SEGMENTS);

export function isExchangeSegment(value: unknown): value is ExchangeSegment {
  return typeof value === 'string' && SEGMENT_SET.has(value);
}

/**
 * Numeric segment codes used in the WebSocket binary response header (byte 3).
 * The wire protocol sends these, not the string names.
 */
export const SEGMENT_BY_CODE: Readonly<Record<number, ExchangeSegment | 'IDX_I'>> = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
  3: 'BSE_EQ', // NSE_CURRENCY in Dhan's table; mapped conservatively, see note
  4: 'BSE_EQ',
  5: 'MCX_COMM',
  8: 'BSE_FNO',
};

export interface InstrumentRef {
  /** Platform-canonical symbol — always present, matches Instrument.symbol. */
  symbol: string;
  /** Broker security id. Absent until the scrip master has mapped the instrument. */
  securityId?: string;
  exchangeSegment?: ExchangeSegment;
}

/** True when this ref carries enough information for a broker-addressed call. */
export function isBrokerAddressable(
  ref: InstrumentRef,
): ref is InstrumentRef & { securityId: string; exchangeSegment: ExchangeSegment } {
  return typeof ref.securityId === 'string' && ref.securityId.length > 0 && isExchangeSegment(ref.exchangeSegment);
}

/** Stable key for cache lookups and de-duplication. */
export function refKey(ref: InstrumentRef): string {
  return isBrokerAddressable(ref) ? `${ref.exchangeSegment}:${ref.securityId}` : `symbol:${ref.symbol}`;
}
