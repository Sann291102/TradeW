/**
 * The tradable universe — a provider-neutral catalogue of everything the
 * platform can quote, across five markets.
 *
 *   INDIA   NSE + BSE, from Dhan's scrip master        quoted INR, settled INR
 *   USA     NYSE + NASDAQ + AMEX, from Twelve Data     quoted USD, settled USD
 *   UK      LSE, from Twelve Data                      quoted GBX/GBP, settled USD
 *   FOREX   every pair Twelve Data lists               quoted in the pair's own
 *                                                      quote leg, settled USD/INR
 *   CRYPTO  every Binance spot pair                    quoted in the pair's quote
 *                                                      asset, settled USD
 *
 * The two currency columns are never collapsed into one. See
 * `currency-policy.ts` — it is the file to read first if anything about money
 * here looks surprising.
 */

export * from './universe.contracts';
export * from './currency-policy';
export * from './normalise';
export * from './sources/dhan.catalogue';
export * from './sources/twelvedata.catalogue';
export * from './sources/binance.catalogue';
export * from './sources/registry';
