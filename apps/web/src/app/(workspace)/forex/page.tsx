import { ForexClient } from './ForexClient';

export const metadata = { title: 'Forex — TradeW' };

/**
 * Foreign-exchange board. Real interbank spot from Twelve Data, read-only.
 *
 * Not sourced from Dhan: verified 2026-07-28, Dhan carries no live currency
 * contracts at all — every NSE/BSE FUT/OPTCUR row in its scrip master expired
 * on or before 2026-06-26. Not sourced from Binance either: it lists no
 * fiat/fiat pair, only EUR against a dollar stablecoin.
 *
 * Not tradeable, for the same reason as crypto: spot FX quotes to 4-5 decimals
 * in fractional units, and the OMS stores quantity as an `Int` with prices at
 * `Decimal(12,2)` — EUR/USD at 1.13703 would round to 1.14.
 */
export default function ForexPage() {
  return <ForexClient />;
}
