'use client';

import { CRYPTO_POLL_MS, fetchCryptoQuotes } from '@/lib/externalMarkets';
import { GlobalMarketBoard, type BoardRow } from '@/components/markets/GlobalMarketBoard';

/** Binance quotes carry many decimals; 2 reads fine for the majors board. */
const PRICE_PRECISION = 2;

async function load(): Promise<BoardRow[]> {
  const quotes = await fetchCryptoQuotes();
  return quotes.map((q) => ({
    symbol: q.symbol,
    displayName: q.displayName,
    ltp: q.ltp,
    change: q.change,
    changePct: q.changePct,
    high: q.high,
    low: q.low,
    marketOpen: q.marketOpen,
  }));
}

export function CryptoClient() {
  return (
    <div className="mx-auto max-w-[1100px] space-y-4 p-4">
      <GlobalMarketBoard
        title="Crypto"
        subtitle="· 24/7"
        sourceLabel="Live prices from Binance."
        load={load}
        pollMs={CRYPTO_POLL_MS}
        precision={PRICE_PRECISION}
      />
    </div>
  );
}
