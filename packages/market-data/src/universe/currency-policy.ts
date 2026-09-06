/**
 * MARKET CURRENCY vs PAPER-ACCOUNT CURRENCY.
 *
 * These are two different facts about one instrument and conflating them is the
 * single most damaging error this subsystem can make, because it is silent: a
 * wrong price still renders, still charts, still fills a paper order, and only
 * looks wrong to someone who already knows the right answer.
 *
 *   quoteCurrency    what the VENUE prices the instrument in.
 *                    NSE/BSE quote INR. NYSE/NASDAQ/AMEX quote USD. The LSE
 *                    quotes most of its order book in GBX — pence, one
 *                    hundredth of a pound. A forex pair is quoted in its own
 *                    second leg. A Binance spot pair is quoted in its quote
 *                    asset (USDT, USDC, BTC, ...).
 *
 *   accountCurrency  what the PAPER-TRADING account settles in.
 *                    India: INR. USA, UK, forex and crypto: USD. This is
 *                    product direction, not a property of any venue.
 *
 * THE TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. A market price is stored, transported and displayed in its
 *     `quoteCurrency`, exactly as the provider published it. Nothing in the
 *     ingest or read path rescales it. A GBX price of 2,431 means 2,431 pence
 *     and is shown as such; turning it into 24.31 "because GBP" or into dollars
 *     "because the account is USD" both corrupt the instrument's own history.
 *
 *  2. Converting to the account currency is an EXPLICIT, RATE-BEARING act.
 *     `convertToAccountCurrency` refuses to run without a real FX rate and
 *     returns the rate it used alongside the number, so every converted figure
 *     can be audited back to the quote it came from. There is no default rate,
 *     no cached-forever rate and no 1.0 fallback: a missing rate is an error,
 *     never an invisible identity conversion.
 *
 * Nothing here fetches a rate. Rate acquisition belongs to whoever has a live
 * FX source (services/api's ForexService); this module only makes it impossible
 * to convert without one.
 */

import type { UniverseExchange, UniverseMarket } from './universe.contracts';

/** ISO 4217, plus GBX — a real, distinct minor-unit quotation, not an alias. */
export type CurrencyCode = string;

/**
 * The paper-trading settlement currency per market, as specified by the product:
 * Indian trades settle in rupees, everything else in dollars.
 */
export const ACCOUNT_CURRENCY_BY_MARKET: Readonly<Record<UniverseMarket, CurrencyCode>> = {
  INDIA: 'INR',
  USA: 'USD',
  UK: 'USD',
  FOREX: 'USD',
  CRYPTO: 'USD',
};

/**
 * The default quotation currency per venue.
 *
 * GBX for the LSE is deliberate and is the one entry here that surprises people.
 * The LSE's order book quotes ordinary shares in pence: VOD prints around 70,
 * not around 0.70. Recording that as `GBP` would make every UK price a hundred
 * times too large the moment anything reasoned about it in pounds. Providers do
 * publish per-instrument currency (some LSE lines are quoted in USD or EUR), and
 * the source adapters pass that through — this table is only the fallback for
 * when a provider says nothing.
 */
export const DEFAULT_QUOTE_CURRENCY_BY_EXCHANGE: Readonly<Record<UniverseExchange, CurrencyCode>> = {
  NSE: 'INR',
  BSE: 'INR',
  NYSE: 'USD',
  NASDAQ: 'USD',
  AMEX: 'USD',
  LSE: 'GBX',
  FX: 'USD',
  BINANCE: 'USDT',
};

/** Minor-unit quotations and how many of them make one major unit. */
const MINOR_UNIT_CURRENCIES: Readonly<Record<string, { major: CurrencyCode; per: number }>> = {
  // London pence. `GBp` is the other common spelling; both normalise to GBX.
  GBX: { major: 'GBP', per: 100 },
  // Johannesburg cents, present on some LSE-listed dual lines.
  ZAC: { major: 'ZAR', per: 100 },
  // Tel Aviv agorot, likewise.
  ILA: { major: 'ILS', per: 100 },
};

/**
 * Normalise a provider's currency string. Providers spell London pence as
 * `GBp`, `GBX`, `GBPp` and occasionally `PENCE`; treating those as four
 * currencies would split the same instrument's history across four scales.
 */
export function normaliseCurrency(raw: string | undefined | null, fallback: CurrencyCode): CurrencyCode {
  const v = (raw ?? '').trim();
  if (!v) return fallback;
  const upper = v.toUpperCase();
  // `GBp` is case-significant in vendor feeds: capital-P `GBP` is pounds, so
  // this check is on the original string, not the upper-cased one.
  if (v === 'GBp' || upper === 'GBX' || upper === 'GBPP' || upper === 'PENCE') return 'GBX';
  if (upper === 'ZAC' || v === 'ZAr') return 'ZAC';
  if (upper === 'ILA' || v === 'ILa') return 'ILA';
  return upper;
}

/** True when the currency is quoted in minor units (pence, cents, agorot). */
export function isMinorUnitCurrency(currency: CurrencyCode): boolean {
  return currency.toUpperCase() in MINOR_UNIT_CURRENCIES;
}

/**
 * The major-unit currency and divisor behind a minor-unit quotation.
 * Returns null for ordinary currencies — the common case.
 */
export function minorUnitOf(currency: CurrencyCode): { major: CurrencyCode; per: number } | null {
  return MINOR_UNIT_CURRENCIES[currency.toUpperCase()] ?? null;
}

export interface CurrencyPolicy {
  /** What the venue quotes in. Prices are stored and shown in this. */
  quoteCurrency: CurrencyCode;
  /** What the paper account settles in. */
  accountCurrency: CurrencyCode;
  /** True when showing a price in the account's currency needs an FX rate. */
  requiresFxConversion: boolean;
}

/**
 * Resolve the currency policy for one instrument.
 *
 * `providerCurrency` wins when a provider actually publishes one — an LSE line
 * quoted in USD is a real thing and the venue default must not override it.
 */
export function resolveCurrencyPolicy(input: {
  market: UniverseMarket;
  exchange: UniverseExchange;
  providerCurrency?: string | null;
  /** Forex/crypto: the pair's quote leg, which IS the quotation currency. */
  quoteAsset?: string | null;
}): CurrencyPolicy {
  const accountCurrency = ACCOUNT_CURRENCY_BY_MARKET[input.market];

  // A pair is quoted in its own second leg, by definition. EUR/USD is priced in
  // USD; USD/INR is priced in INR; BTCUSDT is priced in USDT. Deriving that
  // from the venue instead would price every FX pair in dollars, which is wrong
  // for exactly the pairs an Indian trader cares about.
  const fromPair = input.quoteAsset ? input.quoteAsset.trim().toUpperCase() : '';
  const fallback = fromPair || DEFAULT_QUOTE_CURRENCY_BY_EXCHANGE[input.exchange];
  const quoteCurrency = normaliseCurrency(input.providerCurrency, fallback);

  return {
    quoteCurrency,
    accountCurrency,
    requiresFxConversion: !isSameMoney(quoteCurrency, accountCurrency),
  };
}

/**
 * Whether two currency codes denominate the same money at the same scale.
 *
 * GBX and GBP are the same *currency* but NOT the same scale, so they are not
 * "same money" here — a GBX price needs a divide-by-100 before it is a GBP
 * price, and calling them equal is precisely how a 100x error gets in.
 *
 * The USD stablecoins are a deliberate judgement call in the other direction:
 * USDT and USDC are NOT the US dollar, they are dollar-referenced tokens that
 * have historically traded off peg. A BTCUSDT price is treated as needing
 * conversion into a USD account, at a rate someone must supply, rather than
 * being silently declared to be dollars.
 */
export function isSameMoney(a: CurrencyCode, b: CurrencyCode): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Raised instead of guessing. Never caught-and-defaulted inside this module. */
export class FxRateRequiredError extends Error {
  constructor(
    readonly from: CurrencyCode,
    readonly to: CurrencyCode,
  ) {
    super(
      `Converting ${from} to ${to} requires a live FX rate. No rate was supplied, and this module ` +
        `will not assume one — an assumed rate produces a plausible-looking wrong number.`,
    );
    this.name = 'FxRateRequiredError';
  }
}

export interface ConvertedMoney {
  /** The figure in the ACCOUNT's currency. */
  amount: number;
  currency: CurrencyCode;
  /** The untouched market figure, so the original is never lost. */
  sourceAmount: number;
  sourceCurrency: CurrencyCode;
  /**
   * The full multiplier applied, minor-unit rescaling included. `null` when no
   * conversion happened (the currencies already matched), which is how a caller
   * distinguishes "not converted" from "converted at 1.0".
   */
  rate: number | null;
}

/**
 * Convert a market price into the paper account's currency — explicitly.
 *
 * `rates` maps a MAJOR-unit currency pair to its rate, e.g. `{ 'GBP/USD': 1.27 }`.
 * Minor-unit quotations are rescaled first (GBX -> GBP, /100) and then converted,
 * so a caller never has to know that the LSE quotes in pence, and a rate table
 * never has to carry a `GBX/USD` entry that would be a hundred times the real
 * exchange rate.
 *
 * Throws `FxRateRequiredError` when the needed rate is absent. That is the whole
 * point: the failure is loud, at the boundary, instead of a wrong number
 * downstream.
 */
export function convertToAccountCurrency(
  amount: number,
  quoteCurrency: CurrencyCode,
  accountCurrency: CurrencyCode,
  rates: Readonly<Record<string, number>> = {},
): ConvertedMoney {
  const from = quoteCurrency.toUpperCase();
  const to = accountCurrency.toUpperCase();

  if (isSameMoney(from, to)) {
    return { amount, currency: to, sourceAmount: amount, sourceCurrency: from, rate: null };
  }

  // Rescale a minor-unit quotation into its major unit before looking for a
  // rate. This is arithmetic on a known constant, not an exchange rate.
  const minor = minorUnitOf(from);
  const majorAmount = minor ? amount / minor.per : amount;
  const majorFrom = minor ? minor.major : from;
  const scale = minor ? 1 / minor.per : 1;

  if (isSameMoney(majorFrom, to)) {
    return { amount: majorAmount, currency: to, sourceAmount: amount, sourceCurrency: from, rate: scale };
  }

  const rate = lookupRate(rates, majorFrom, to);
  if (rate === null) throw new FxRateRequiredError(from, to);

  return {
    amount: majorAmount * rate,
    currency: to,
    sourceAmount: amount,
    sourceCurrency: from,
    rate: scale * rate,
  };
}

/**
 * Find `FROM/TO` in the rate table, accepting the inverse quote.
 *
 * FX convention publishes one direction per pair — `USD/INR`, not `INR/USD` —
 * so a table built from a vendor's majors list would otherwise be missing half
 * the conversions a five-market platform needs.
 */
export function lookupRate(
  rates: Readonly<Record<string, number>>,
  from: CurrencyCode,
  to: CurrencyCode,
): number | null {
  const a = from.toUpperCase();
  const b = to.toUpperCase();
  const direct = rates[`${a}/${b}`] ?? rates[`${a}${b}`];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  const inverse = rates[`${b}/${a}`] ?? rates[`${b}${a}`];
  if (typeof inverse === 'number' && Number.isFinite(inverse) && inverse > 0) return 1 / inverse;
  return null;
}

/**
 * Format a market price for display in ITS OWN currency.
 *
 * Used everywhere a price is shown next to an instrument, precisely so that the
 * default rendering path never converts. Pence render as `2,431.00p`, rupees
 * with `₹`, dollars with `$`.
 */
export function formatQuotePrice(amount: number, currency: CurrencyCode, maximumFractionDigits = 2): string {
  const code = currency.toUpperCase();
  if (code === 'GBX') {
    return `${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits })}p`;
  }
  const symbols: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
  const symbol = symbols[code];
  const formatted = amount.toLocaleString(code === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  });
  return symbol ? `${symbol}${formatted}` : `${formatted} ${code}`;
}
