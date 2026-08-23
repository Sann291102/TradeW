/**
 * Vendor symbol -> TradingView symbol, for the USD venues.
 *
 * The Markets board and the TradingView embed are two different price feeds
 * (see `components/charts/TradingViewWidget.tsx`). Nothing can reconcile them
 * at runtime — the iframe is cross-origin — so the only lever that keeps them
 * agreeing is which exchange each mapping points at. That makes this file the
 * load-bearing part of the embed, not a lookup table of convenience.
 *
 * Every symbol is EXCHANGE-PREFIXED on purpose. An unprefixed `BTCUSDT` lets
 * TradingView pick a venue, and the one it picks is not necessarily the one we
 * quote; an unprefixed `EURUSD` resolves to a different aggregator on different
 * accounts. Prefixing removes that entirely.
 */

/**
 * Crypto: `BTCUSDT` -> `BINANCE:BTCUSDT`.
 *
 * Exact-venue match. `services/api/src/crypto` polls Binance's public REST API
 * and TradingView carries Binance as a first-class exchange, so the board and
 * the chart are reading the same order book. Any difference between them is
 * tick latency, not a different market.
 *
 * All twelve symbols on the default board (`DEFAULT_CRYPTO_SYMBOLS`) are
 * spot USDT pairs listed on Binance, so this holds for the whole board rather
 * than for a curated subset.
 */
export function cryptoTradingViewSymbol(binanceSymbol: string): string {
  return `BINANCE:${binanceSymbol.toUpperCase()}`;
}

/**
 * FX: `EUR/USD` -> `FX_IDC:EURUSD`.
 *
 * NOT an exact-venue match, and worth being precise about why. Our board is
 * Twelve Data's interbank composite; `FX_IDC` is TradingView's own ICE Data
 * composite. Both are aggregates of the same underlying interbank market, so
 * the majors agree to well under a pip, but they are not the same number and
 * will not tick together.
 *
 * `FX_IDC` rather than `FX`: it carries USD/INR, which is on the default board
 * as the home-currency pair (`DEFAULT_FX_PAIRS`) and is the one pair a TradeW
 * user is most likely to look up. Splitting the prefix per-pair to chase a
 * marginally tighter feed on the majors would mean two sources of truth on one
 * board for no real gain.
 *
 * There is no exact-match option here: Twelve Data is not a TradingView
 * exchange. This is the honest closest thing, which is why the FX chart's
 * source note names both feeds.
 */
export function fxTradingViewSymbol(pair: string): string {
  return `FX_IDC:${pair.replace('/', '').toUpperCase()}`;
}
