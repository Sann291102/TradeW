/**
 * The Dhan bridge source: quote bucketing, and fault-versus-absence.
 *
 * Both regressions here were found against the running bridge, not reasoned
 * about — the first silently cost Gold its entire freshness signal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DhanBridgeSource } from './dhan-bridge.source';
import { MarketDataUnavailable } from './market-data.port';

/** Stub `fetch`, routing by URL path. */
function stubFetch(routes: Record<string, unknown>, status = 200): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (key ? routes[key] : {}),
    };
  });
}

const candles = {
  source: 'dhan',
  candles: [
    { timestamp: Date.UTC(2026, 8, 9, 3, 45), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DhanBridgeSource quote lookup', () => {
  it('finds a commodity quote, which lives outside the `indices` bucket', async () => {
    // The exact shape the live bridge returns: buckets by asset class. Gold is
    // in `commodities`, and a source that only reads `indices` gets null —
    // which is indistinguishable from "the bridge has no quote for this", so
    // the instrument silently loses its liveness signal.
    stubFetch({
      '/candles': candles,
      '/quotes': {
        marketOpen: true,
        indices: [{ symbol: 'NIFTY', ltp: 23500, marketStatus: 'open', updatedAt: '2026-09-09T08:00:00.000Z' }],
        stocks: [],
        etfs: [],
        commodities: [
          { symbol: 'GOLD', ltp: 153357, marketStatus: 'open', updatedAt: '2026-09-09T08:36:38.000Z' },
        ],
      },
    });

    const read = await new DhanBridgeSource().read('GOLD', '15m', 5);

    expect(read.lastPrice).toBe(153357);
    expect(read.lastDataAt?.toISOString()).toBe('2026-09-09T08:36:38.000Z');
    expect(read.marketOpen).toBe(true);
  });

  it('still finds an index quote', async () => {
    stubFetch({
      '/candles': candles,
      '/quotes': {
        indices: [{ symbol: 'NIFTY', ltp: 23500, marketStatus: 'open', updatedAt: '2026-09-09T08:00:00.000Z' }],
      },
    });

    const read = await new DhanBridgeSource().read('NIFTY', '15m', 5);
    expect(read.lastPrice).toBe(23500);
  });

  it('survives a missing quote without failing the whole read', async () => {
    stubFetch({ '/candles': candles, '/quotes': { indices: [] } });

    const read = await new DhanBridgeSource().read('NIFTY', '15m', 5);
    // The bars are still usable; freshness is honestly unknown rather than
    // invented, and the gate downstream refuses on a null.
    expect(read.candles).toHaveLength(1);
    expect(read.lastPrice).toBeNull();
    expect(read.lastDataAt).toBeNull();
  });
});

describe('DhanBridgeSource fault handling', () => {
  it('treats the bridge’s HTTP-200 `source: "error"` as a fault, not an empty market', async () => {
    // The bridge answers 200 with a NAMED fault when Dhan refuses it. Reading
    // that as "no candles" is how a dead credential gets reported as a quiet
    // market — the 2026-08-17 failure, exactly.
    stubFetch({
      '/candles': { candles: [], source: 'error', fault: 'dhan credential refused (401)' },
      '/quotes': { indices: [] },
    });

    await expect(new DhanBridgeSource().read('NIFTY', '15m', 5)).rejects.toBeInstanceOf(
      MarketDataUnavailable,
    );
    await expect(new DhanBridgeSource().read('NIFTY', '15m', 5)).rejects.toThrow(
      /credential refused/,
    );
  });

  it('reports a non-200 from the bridge as a fault', async () => {
    stubFetch({ '/candles': {}, '/quotes': {} }, 503);
    await expect(new DhanBridgeSource().read('NIFTY', '15m', 5)).rejects.toThrow(/HTTP 503/);
  });

  it('an empty-but-successful candle list is a market fact, not a fault', async () => {
    stubFetch({ '/candles': { candles: [], source: 'none' }, '/quotes': { indices: [] } });

    const read = await new DhanBridgeSource().read('NIFTY', '15m', 5);
    expect(read.candles).toEqual([]);
  });
});
