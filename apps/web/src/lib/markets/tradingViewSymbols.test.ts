import { describe, it, expect } from 'vitest';
import { cryptoTradingViewSymbol, fxTradingViewSymbol } from './tradingViewSymbols';

/**
 * These mappings are the only thing keeping the TradingView embed and the
 * Markets board pointed at the same market — nothing can reconcile the two at
 * runtime, because the widget renders in a cross-origin iframe. A regression
 * here does not throw and does not look broken: it quietly draws a different
 * venue's chart under our prices. Hence tests on what is otherwise two lines
 * of string handling.
 */

/** Mirrors DEFAULT_CRYPTO_SYMBOLS in services/api/src/crypto/crypto.service.ts. */
const DEFAULT_CRYPTO_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'TRXUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'MATICUSDT',
];

/** Mirrors DEFAULT_FX_PAIRS in services/api/src/crypto/forex.service.ts. */
const DEFAULT_FX_PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/INR',
  'AUD/USD',
  'USD/CHF',
  'USD/CAD',
  'NZD/USD',
];

describe('cryptoTradingViewSymbol', () => {
  it('targets Binance — the same exchange the crypto board polls', () => {
    expect(cryptoTradingViewSymbol('BTCUSDT')).toBe('BINANCE:BTCUSDT');
  });

  it('maps every symbol on the default board', () => {
    for (const symbol of DEFAULT_CRYPTO_SYMBOLS) {
      expect(cryptoTradingViewSymbol(symbol)).toBe(`BINANCE:${symbol}`);
    }
  });

  it('upper-cases, so a lower-case vendor symbol cannot miss', () => {
    expect(cryptoTradingViewSymbol('btcusdt')).toBe('BINANCE:BTCUSDT');
  });

  it('always emits an exchange prefix', () => {
    // An unprefixed symbol lets TradingView choose the venue, which is the
    // specific failure this mapping exists to prevent.
    for (const symbol of DEFAULT_CRYPTO_SYMBOLS) {
      expect(cryptoTradingViewSymbol(symbol)).toContain(':');
    }
  });
});

describe('fxTradingViewSymbol', () => {
  it('strips the slash and prefixes the ICE Data composite', () => {
    expect(fxTradingViewSymbol('EUR/USD')).toBe('FX_IDC:EURUSD');
  });

  it('maps every pair on the default board', () => {
    for (const pair of DEFAULT_FX_PAIRS) {
      const mapped = fxTradingViewSymbol(pair);
      expect(mapped).toBe(`FX_IDC:${pair.replace('/', '')}`);
      expect(mapped).not.toContain('/');
    }
  });

  it('covers USD/INR, the home-currency pair FX_IDC was chosen for', () => {
    expect(fxTradingViewSymbol('USD/INR')).toBe('FX_IDC:USDINR');
  });

  it('upper-cases', () => {
    expect(fxTradingViewSymbol('eur/usd')).toBe('FX_IDC:EURUSD');
  });
});
