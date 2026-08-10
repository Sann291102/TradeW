import { CryptoClient } from './CryptoClient';

export const metadata = { title: 'Crypto — TradeW' };

/**
 * Crypto market board. Real Binance prices, read-only.
 *
 * Not tradeable: the paper OMS stores order quantity as an `Int` and prices as
 * `Decimal(12,2)`, so the smallest possible crypto order would be one whole
 * BTC and any asset under ₹0.01 would round to zero. Enabling it means
 * widening those columns across Order/Trade/Position — the same arithmetic
 * that currently has no test coverage — so it is sequenced after that work.
 */
export default function CryptoPage() {
  return <CryptoClient />;
}
