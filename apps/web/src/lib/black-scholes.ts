/**
 * Black-Scholes option pricing/Greeks — standard formulas, our own
 * implementation. Used to compute real Delta/Gamma/Theta/Vega for the Option
 * Chain given a (mocked) implied-vol input; not lifted from any platform.
 */

function normCdf(x: number): number {
  return (1 + erf(x / Math.SQRT2)) / 2;
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Abramowitz & Stegun 7.1.26 approximation
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

function d1d2(spot: number, strike: number, t: number, sigma: number, rate: number): { d1: number; d2: number } {
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * t) / (sigma * Math.sqrt(t));
  return { d1, d2: d1 - sigma * Math.sqrt(t) };
}

/**
 * Theoretical option premium — used to derive a synthetic option-premium
 * candle series from the underlying's real mock candles (see
 * lib/mock/optionCandles.ts), since no live per-contract candle feed exists.
 */
export function blackScholesPrice(
  spot: number,
  strike: number,
  yearsToExpiry: number,
  ivPct: number,
  optionType: 'call' | 'put',
  rate = 0.065,
): number {
  const sigma = Math.max(ivPct, 0.01) / 100;
  const t = Math.max(yearsToExpiry, 1 / 365);
  const { d1, d2 } = d1d2(spot, strike, t, sigma, rate);
  if (optionType === 'call') {
    return spot * normCdf(d1) - strike * Math.exp(-rate * t) * normCdf(d2);
  }
  return strike * Math.exp(-rate * t) * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * @param spot underlying price
 * @param strike option strike
 * @param yearsToExpiry time to expiry in years (e.g. 7/365)
 * @param ivPct implied volatility, as a percentage (e.g. 14.5)
 * @param rate risk-free rate, as a decimal (default ~India 10y-ish proxy)
 */
export function blackScholesGreeks(
  spot: number,
  strike: number,
  yearsToExpiry: number,
  ivPct: number,
  optionType: 'call' | 'put',
  rate = 0.065,
): Greeks {
  const sigma = Math.max(ivPct, 0.01) / 100;
  const t = Math.max(yearsToExpiry, 1 / 365);
  const { d1, d2 } = d1d2(spot, strike, t, sigma, rate);

  const gamma = normPdf(d1) / (spot * sigma * Math.sqrt(t));
  const vega = (spot * normPdf(d1) * Math.sqrt(t)) / 100; // per 1% IV move

  if (optionType === 'call') {
    const delta = normCdf(d1);
    const theta =
      (-((spot * normPdf(d1) * sigma) / (2 * Math.sqrt(t))) - rate * strike * Math.exp(-rate * t) * normCdf(d2)) / 365;
    return { delta, gamma, theta, vega };
  }
  const delta = normCdf(d1) - 1;
  const theta =
    (-((spot * normPdf(d1) * sigma) / (2 * Math.sqrt(t))) + rate * strike * Math.exp(-rate * t) * normCdf(-d2)) / 365;
  return { delta, gamma, theta, vega };
}
