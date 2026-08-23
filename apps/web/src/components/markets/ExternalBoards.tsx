'use client';

import {
  CRYPTO_POLL_MS,
  FX_POLL_MS,
  fetchCryptoQuotes,
  fetchFxQuotes,
} from '@/lib/externalMarkets';
import { GlobalMarketBoard, type BoardRow } from './GlobalMarketBoard';

/**
 * The two USD venues, as boards mountable inside the Markets workspace.
 *
 * These were `app/(workspace)/crypto/CryptoClient.tsx` and its Forex twin,
 * each a standalone page reached from its own sidebar entry. Crypto and FX are
 * venues, not product areas — the same thing Indices and Commodities are — so
 * they now sit as tabs under Markets and those two routes redirect here.
 *
 * The page-level wrappers (`mx-auto max-w-[1100px] p-4`) are deliberately gone:
 * these render inside the Markets layout, which owns the page's width and
 * padding. The original client components are untouched and still work if
 * mounted directly (repo Rule 1) — they are simply no longer what /crypto and
 * /forex render.
 */

/** Binance quotes carry many decimals; 2 reads fine for the majors board. */
export const CRYPTO_PRECISION = 2;
/** FX moves in pips — 4 decimals is the minimum that shows a real move. */
export const FX_PRECISION = 4;

async function loadCrypto(): Promise<BoardRow[]> {
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

async function loadFx(): Promise<BoardRow[]> {
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

interface VenueBoardProps {
  onSelectSymbol: (symbol: string) => void;
  selectedSymbol: string | null;
  /** Publishes each poll's rows so the detail pane can read the selected
   *  instrument's quote off the SAME feed the board renders, rather than
   *  opening a second poll that could disagree with it. */
  onRowsChange: (rows: BoardRow[]) => void;
}

export function CryptoBoard({ onSelectSymbol, selectedSymbol, onRowsChange }: VenueBoardProps) {
  return (
    <GlobalMarketBoard
      title="Crypto"
      subtitle="· 24/7 · USD"
      sourceLabel="Live prices from Binance."
      load={loadCrypto}
      pollMs={CRYPTO_POLL_MS}
      precision={CRYPTO_PRECISION}
      onSelectSymbol={onSelectSymbol}
      selectedSymbol={selectedSymbol}
      onRowsChange={onRowsChange}
    />
  );
}

export function ForexBoard({ onSelectSymbol, selectedSymbol, onRowsChange }: VenueBoardProps) {
  return (
    <GlobalMarketBoard
      title="Forex"
      subtitle="· interbank spot · USD"
      sourceLabel="Live prices from Twelve Data."
      load={loadFx}
      pollMs={FX_POLL_MS}
      precision={FX_PRECISION}
      note="Refreshed once a minute to stay inside the data provider's rate limit."
      onSelectSymbol={onSelectSymbol}
      selectedSymbol={selectedSymbol}
      onRowsChange={onRowsChange}
    />
  );
}
