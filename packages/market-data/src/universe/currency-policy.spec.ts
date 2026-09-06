import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CURRENCY_BY_MARKET,
  FxRateRequiredError,
  convertToAccountCurrency,
  formatQuotePrice,
  isSameMoney,
  lookupRate,
  normaliseCurrency,
  resolveCurrencyPolicy,
} from './currency-policy';

/**
 * The market-currency vs account-currency separation, as executable rules.
 *
 * Every assertion here corresponds to a wrong number that would otherwise be
 * shippable and plausible on screen: a UK price a hundred times too large, a
 * rupee figure rendered as dollars, a stablecoin quietly declared to be USD, or
 * a conversion that silently used a rate of 1.
 */

describe('account currency per market', () => {
  it('settles India in rupees and every other market in dollars', () => {
    expect(ACCOUNT_CURRENCY_BY_MARKET).toEqual({
      INDIA: 'INR',
      USA: 'USD',
      UK: 'USD',
      FOREX: 'USD',
      CRYPTO: 'USD',
    });
  });
});

describe('resolveCurrencyPolicy', () => {
  it('quotes Indian venues in INR and settles them in INR — no conversion', () => {
    const nse = resolveCurrencyPolicy({ market: 'INDIA', exchange: 'NSE' });
    expect(nse).toEqual({ quoteCurrency: 'INR', accountCurrency: 'INR', requiresFxConversion: false });
    expect(resolveCurrencyPolicy({ market: 'INDIA', exchange: 'BSE' }).quoteCurrency).toBe('INR');
  });

  it('quotes US venues in USD and settles them in USD — no conversion', () => {
    for (const exchange of ['NYSE', 'NASDAQ', 'AMEX'] as const) {
      expect(resolveCurrencyPolicy({ market: 'USA', exchange })).toEqual({
        quoteCurrency: 'USD',
        accountCurrency: 'USD',
        requiresFxConversion: false,
      });
    }
  });

  it('quotes the LSE in pence but settles it in dollars, and says conversion is needed', () => {
    const lse = resolveCurrencyPolicy({ market: 'UK', exchange: 'LSE' });
    expect(lse.quoteCurrency).toBe('GBX');
    expect(lse.accountCurrency).toBe('USD');
    expect(lse.requiresFxConversion).toBe(true);
  });

  it('honours a per-instrument currency over the venue default', () => {
    // A real minority of LSE lines are quoted in USD or EUR. Assuming pence for
    // those would divide their prices by a hundred.
    const usdLine = resolveCurrencyPolicy({ market: 'UK', exchange: 'LSE', providerCurrency: 'USD' });
    expect(usdLine.quoteCurrency).toBe('USD');
    expect(usdLine.requiresFxConversion).toBe(false);
  });

  it('prices a currency pair in its own quote leg, not in the account currency', () => {
    // USD/INR is priced in rupees. Pricing it in dollars because the account is
    // a dollar account is the exact error this exists to prevent.
    const usdinr = resolveCurrencyPolicy({ market: 'FOREX', exchange: 'FX', quoteAsset: 'INR' });
    expect(usdinr.quoteCurrency).toBe('INR');
    expect(usdinr.accountCurrency).toBe('USD');
    expect(usdinr.requiresFxConversion).toBe(true);

    const eurusd = resolveCurrencyPolicy({ market: 'FOREX', exchange: 'FX', quoteAsset: 'USD' });
    expect(eurusd.quoteCurrency).toBe('USD');
    expect(eurusd.requiresFxConversion).toBe(false);
  });

  it('prices a crypto pair in its quote asset and does not call a stablecoin USD', () => {
    const btcusdt = resolveCurrencyPolicy({ market: 'CRYPTO', exchange: 'BINANCE', quoteAsset: 'USDT' });
    expect(btcusdt.quoteCurrency).toBe('USDT');
    expect(btcusdt.accountCurrency).toBe('USD');
    // USDT is a dollar-referenced token that has traded off peg; treating it as
    // USD would make an off-peg price look like a dollar price.
    expect(btcusdt.requiresFxConversion).toBe(true);

    const ethbtc = resolveCurrencyPolicy({ market: 'CRYPTO', exchange: 'BINANCE', quoteAsset: 'BTC' });
    expect(ethbtc.quoteCurrency).toBe('BTC');
    expect(ethbtc.requiresFxConversion).toBe(true);
  });
});

describe('normaliseCurrency', () => {
  it('collapses every spelling of London pence onto GBX', () => {
    for (const spelling of ['GBp', 'GBX', 'gbx', 'PENCE']) {
      expect(normaliseCurrency(spelling, 'USD')).toBe('GBX');
    }
  });

  it('keeps capital-P GBP as pounds — the case is significant in vendor feeds', () => {
    expect(normaliseCurrency('GBP', 'USD')).toBe('GBP');
  });

  it('falls back when the provider says nothing', () => {
    expect(normaliseCurrency(undefined, 'INR')).toBe('INR');
    expect(normaliseCurrency('  ', 'INR')).toBe('INR');
  });
});

describe('isSameMoney', () => {
  it('treats GBX and GBP as different, because they are different scales', () => {
    expect(isSameMoney('GBX', 'GBP')).toBe(false);
    expect(isSameMoney('usd', 'USD')).toBe(true);
  });
});

describe('convertToAccountCurrency', () => {
  it('returns the untouched figure and a null rate when no conversion is needed', () => {
    const result = convertToAccountCurrency(2500.5, 'INR', 'INR');
    expect(result.amount).toBe(2500.5);
    // null, not 1 — "not converted" and "converted at parity" are different facts.
    expect(result.rate).toBeNull();
  });

  it('refuses to convert without a rate rather than assuming one', () => {
    expect(() => convertToAccountCurrency(2431, 'GBX', 'USD')).toThrow(FxRateRequiredError);
    expect(() => convertToAccountCurrency(100, 'INR', 'USD', {})).toThrow(/requires a live FX rate/);
  });

  it('rescales pence to pounds before applying the rate, and reports the full multiplier', () => {
    // 2,431p = £24.31; at 1.27 that is $30.8737. A rate table must never need a
    // GBX/USD entry — that would be a hundred times the real exchange rate.
    const result = convertToAccountCurrency(2431, 'GBX', 'USD', { 'GBP/USD': 1.27 });
    expect(result.amount).toBeCloseTo(30.8737, 4);
    expect(result.sourceAmount).toBe(2431);
    expect(result.sourceCurrency).toBe('GBX');
    expect(result.rate).toBeCloseTo(0.0127, 6);
  });

  it('rescales a minor unit with no FX step when the major unit IS the account currency', () => {
    const result = convertToAccountCurrency(2431, 'GBX', 'GBP');
    expect(result.amount).toBeCloseTo(24.31, 6);
    expect(result.rate).toBeCloseTo(0.01, 6);
  });

  it('accepts an inverse quote, since FX publishes one direction per pair', () => {
    // The vendor lists USD/INR, never INR/USD. Without the inverse, converting a
    // rupee-quoted instrument into a dollar account would be impossible.
    const result = convertToAccountCurrency(8300, 'INR', 'USD', { 'USD/INR': 83 });
    expect(result.amount).toBeCloseTo(100, 6);
  });
});

describe('lookupRate', () => {
  it('finds a direct quote, an inverse quote, and neither', () => {
    expect(lookupRate({ 'USD/INR': 83 }, 'USD', 'INR')).toBe(83);
    expect(lookupRate({ 'USD/INR': 83 }, 'INR', 'USD')).toBeCloseTo(1 / 83, 10);
    expect(lookupRate({}, 'GBP', 'USD')).toBeNull();
  });

  it('rejects a zero or negative rate instead of dividing by it', () => {
    expect(lookupRate({ 'USD/INR': 0 }, 'USD', 'INR')).toBeNull();
    expect(lookupRate({ 'USD/INR': -1 }, 'INR', 'USD')).toBeNull();
  });
});

describe('formatQuotePrice', () => {
  it('renders pence with a p suffix, never a pound sign', () => {
    // "£2,431" for 2,431 pence is a hundred-fold error that reads as plausible.
    expect(formatQuotePrice(2431, 'GBX')).toBe('2,431.00p');
  });

  it('renders rupees and dollars with their own symbols', () => {
    expect(formatQuotePrice(1500, 'INR')).toBe('₹1,500.00');
    expect(formatQuotePrice(190.25, 'USD')).toBe('$190.25');
  });

  it('falls back to a trailing code for currencies with no symbol', () => {
    expect(formatQuotePrice(1.5, 'USDT')).toBe('1.50 USDT');
  });
});
