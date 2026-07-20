import type { Candle, CandleInterval, MarketDataProvider } from '@tradew/types';

/**
 * Deterministic mock OHLCV generator — the interim candle source behind
 * `TradeChart`/`useCandles` until a real provider (Dhan, per
 * docs/product-architecture/) is wired into services/api (no `Candle` model
 * exists there yet). Only implements `getCandles`, the one method this
 * phase's chart consumes — a real `MarketDataProvider` swaps in at the
 * `useCandles` call site later without this file changing shape.
 *
 * Seeded-random-walk approach mirrors services/sentinel's
 * `SimMarketDataProvider` so mock candles look consistent with the rest of
 * the platform's simulated data.
 */
export const mockMarketDataProvider: Pick<MarketDataProvider, 'getCandles'> = {
  async getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    const intervalMs: Record<CandleInterval, number> = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
      '1d': 86_400_000,
    };
    const step = intervalMs[interval];
    const count = Math.min(500, Math.max(1, Math.floor((to.getTime() - from.getTime()) / step)));

    let seed = 0;
    for (const c of symbol) seed = (seed * 31 + c.charCodeAt(0)) | 0;
    seed = Math.abs(seed) + 1;
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };

    let price = symbol.includes('BANKNIFTY') ? 52700 : symbol.includes('NIFTY') ? 24850 : 500 + (seed % 3000);
    const candles: Candle[] = [];
    for (let i = 0; i < count; i++) {
      const drift = (rand() - 0.5) * 0.004 * price;
      const open = price;
      const close = Math.max(1, price + drift);
      const high = Math.max(open, close) * (1 + rand() * 0.002);
      const low = Math.min(open, close) * (1 - rand() * 0.002);
      const volume = Math.floor(50_000 + rand() * 150_000);
      candles.push({ timestamp: new Date(from.getTime() + i * step), open, high, low, close, volume });
      price = close;
    }
    return candles;
  },
};
