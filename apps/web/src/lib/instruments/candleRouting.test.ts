import { describe, expect, it } from 'vitest';
import { INSTRUMENT_CATALOG, instrumentBySymbol } from './catalog';

/**
 * Which backend serves an instrument's bars.
 *
 * `useCandles` used to call `fetchDhanCandles` for every symbol, which is why
 * a crypto pair could only ever come back empty — reported by the panel,
 * accurately but uselessly, as "Dhan returned no candles for BTCUSDT". It now
 * dispatches on `candleSource`, and the dangerous failure mode of that change
 * is the opposite one: routing a symbol to the WRONG provider draws a real,
 * plausible chart of a different market under this symbol's name, and nothing
 * at runtime can detect it. Same class of silent error as the TradingView
 * prefix mismatch that `tradingViewSymbols.test.ts` exists to prevent.
 *
 * So the routing decision is asserted here rather than eyeballed.
 */

describe('candle routing', () => {
  it('routes Indian instruments to Dhan', () => {
    for (const symbol of ['NIFTY', 'BANKNIFTY', 'RELIANCE']) {
      expect(instrumentBySymbol(symbol)?.candleSource, `${symbol} must stay on Dhan`).toBe('dhan');
    }
  });

  it('routes crypto to Binance', () => {
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      expect(instrumentBySymbol(symbol)?.candleSource, `${symbol} must come from Binance`).toBe('binance');
    }
  });

  it('never routes a non-Indian instrument to the Dhan bridge', () => {
    // The bridge resolves symbols against Dhan's scrip master. Asking it for
    // BTCUSDT is not merely useless; if a ticker ever collided it would serve
    // an Indian instrument's history under a crypto name.
    for (const i of INSTRUMENT_CATALOG) {
      if (i.venue === 'NSE' || i.venue === 'BSE') continue;
      expect(i.candleSource, `${i.symbol} (${i.venue}) must not use the Dhan bridge`).not.toBe('dhan');
    }
  });

  it('keeps Twelve Data instruments off the native chart', () => {
    // Its free tier is 8 req/min; a mounted chart refetching every 60s would
    // spend that on one tab. These stay on the embed until a server-side cache
    // exists, and the catalog is where that decision is recorded.
    for (const i of INSTRUMENT_CATALOG) {
      if (i.candleSource !== 'twelvedata') continue;
      expect(i.chartSurface, `${i.symbol} would poll Twelve Data from the chart`).toBe('embed');
    }
  });

  it('gives every native-chart instrument a source useCandles can dispatch on', () => {
    // `loadBars` handles 'binance' and 'dhan'. Anything else returns no bars
    // rather than falling through to Dhan, so a native instrument with an
    // unhandled source would render an empty chart forever.
    const dispatchable = new Set(['dhan', 'binance']);
    for (const i of INSTRUMENT_CATALOG) {
      if (i.chartSurface !== 'native') continue;
      expect(dispatchable.has(i.candleSource ?? ''), `${i.symbol} has an undispatchable candleSource`).toBe(true);
    }
  });
});
