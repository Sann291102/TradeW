import { describe, expect, it } from 'vitest';
import { INSTRUMENT_CATALOG, instrumentBySymbol, instrumentsForAssetClass } from './catalog';
import { chartCapability, resolveInstrument, supportsInterval } from './resolve';

/**
 * The catalog mirrors constants that live in `services/api/src/crypto`, and a
 * mirror that is not asserted is a copy that will drift. These lists are
 * transcribed from the server and compared, following the precedent set by
 * `lib/markets/tradingViewSymbols.test.ts`.
 */

/** Mirrors DEFAULT_CRYPTO_SYMBOLS in services/api/src/crypto/crypto.service.ts. */
const SERVER_CRYPTO = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'TRXUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT',
];

/** Mirrors DEFAULT_FX_PAIRS in services/api/src/crypto/forex.service.ts. */
const SERVER_FX = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/INR', 'AUD/USD', 'USD/CHF', 'USD/CAD', 'NZD/USD'];

/** Mirrors DEFAULT_US_SYMBOLS in services/api/src/crypto/stocks.service.ts. */
const SERVER_US = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NFLX'];

describe('INSTRUMENT_CATALOG', () => {
  it('covers every crypto pair the server boards serve', () => {
    const inCatalog = instrumentsForAssetClass('crypto').map((i) => i.symbol).sort();
    expect(inCatalog).toEqual([...SERVER_CRYPTO].sort());
  });

  it('covers every FX pair the server boards serve', () => {
    const compact = SERVER_FX.map((p) => p.replace('/', '')).sort();
    expect(instrumentsForAssetClass('forex').map((i) => i.symbol).sort()).toEqual(compact);
  });

  it('covers the US board', () => {
    for (const symbol of SERVER_US) {
      expect(instrumentBySymbol(symbol), `${symbol} missing from catalog`).not.toBeNull();
    }
  });

  it('still contains the Indian instruments the assistant already handled', () => {
    for (const symbol of ['NIFTY', 'BANKNIFTY', 'SENSEX', 'RELIANCE']) {
      expect(instrumentBySymbol(symbol), `${symbol} regressed out of the catalog`).not.toBeNull();
    }
  });

  it('has no duplicate symbols', () => {
    const seen = INSTRUMENT_CATALOG.map((i) => i.symbol);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('declares a candle source wherever it claims a native chart', () => {
    // The whole point of `chartSurface` is that the assistant can trust it.
    // A `native` instrument with no candle feed would draw an empty chart —
    // exactly the "quiet but functioning market" failure useCandles forbids.
    for (const i of INSTRUMENT_CATALOG) {
      if (i.chartSurface === 'native') {
        expect(i.candleSource, `${i.symbol} claims a native chart with no candle source`).not.toBeNull();
      }
    }
  });

  it('marks crypto as display-only, because the OMS cannot express it', () => {
    // Order.quantity is an Int and prices are Decimal(12,2): the smallest
    // possible crypto order would be one whole BTC.
    for (const i of instrumentsForAssetClass('crypto')) {
      expect(i.tradeable, `${i.symbol} must not be offered as tradeable`).toBe(false);
    }
  });
});

describe('resolveInstrument', () => {
  it('resolves the crypto phrasings that used to fail outright', () => {
    expect(resolveInstrument('open BTC chart')?.ref.symbol).toBe('BTCUSDT');
    expect(resolveInstrument('open bitcoin')?.ref.symbol).toBe('BTCUSDT');
    expect(resolveInstrument('open ETHUSDT on 15m')?.ref.symbol).toBe('ETHUSDT');
    expect(resolveInstrument('show me solana')?.ref.symbol).toBe('SOLUSDT');
  });

  it('resolves FX pairs written either way', () => {
    expect(resolveInstrument('open EUR/USD')?.ref.symbol).toBe('EURUSD');
    expect(resolveInstrument('show usdinr')?.ref.symbol).toBe('USDINR');
  });

  it('keeps the longest-form-wins rule across the widened catalog', () => {
    // The original bug this rule exists for, still holding.
    expect(resolveInstrument('open bank nifty')?.ref.symbol).toBe('BANKNIFTY');
    expect(resolveInstrument('open nifty 50')?.ref.symbol).toBe('NIFTY');
  });

  it('respects word boundaries so short aliases do not match inside words', () => {
    // 'ADA' is a Cardano alias; 'CANADA' must not resolve to it.
    expect(resolveInstrument('what about canada')?.ref.symbol).not.toBe('ADAUSDT');
  });

  it('returns null for text naming no instrument', () => {
    expect(resolveInstrument('open settings')).toBeNull();
  });
});

describe('chartCapability', () => {
  it('lets the assistant operate a crypto chart', () => {
    const btc = instrumentBySymbol('BTCUSDT')!;
    expect(chartCapability(btc)).toEqual({ canChart: true, canOperate: true, why: null });
  });

  it('says plainly that an embedded chart cannot be operated', () => {
    const eur = instrumentBySymbol('EURUSD')!;
    const cap = chartCapability(eur);
    expect(cap.canChart).toBe(true);
    expect(cap.canOperate).toBe(false);
    expect(cap.why).toMatch(/timeframe/i);
  });
});

describe('supportsInterval', () => {
  it('accepts the intervals the crypto candle route serves', () => {
    const btc = instrumentBySymbol('BTCUSDT')!;
    expect(supportsInterval(btc, '15m')).toBe(true);
    expect(supportsInterval(btc, '1h')).toBe(true);
    // Binance klines have no weekly bucket in VALID_INTERVALS server-side.
    expect(supportsInterval(btc, '1w')).toBe(false);
  });
});
