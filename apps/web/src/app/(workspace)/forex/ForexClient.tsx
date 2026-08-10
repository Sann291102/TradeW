'use client';

import { FX_POLL_MS, fetchFxQuotes } from '@/lib/externalMarkets';
import { GlobalMarketBoard, type BoardRow } from '@/components/markets/GlobalMarketBoard';

/** FX moves in pips — 4 decimals is the minimum that shows a real move. */
const PRICE_PRECISION = 4;

async function load(): Promise<BoardRow[]> {
  const quotes = await fetchFxQuotes();
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

export function ForexClient() {
  return (
    <div className="mx-auto max-w-[1100px] space-y-4 p-4">
      <GlobalMarketBoard
        title="Forex"
        subtitle="· interbank spot"
        sourceLabel="Live prices from Twelve Data."
        load={load}
        pollMs={FX_POLL_MS}
        precision={PRICE_PRECISION}
        note="Refreshed once a minute to stay inside the data provider's rate limit."
      />
    </div>
  );
}
