/**
 * Fundamentals subsystem barrel + provider resolution.
 *
 * `resolveFinancialDataProvider` is the ONLY way a runtime obtains a provider.
 * It is a named lookup rather than a chain of fallbacks on purpose: if the
 * configured vendor is unreachable the correct outcome is "fundamental data is
 * unavailable", not a silent downgrade to some other source whose numbers the
 * page would then attribute to the first. Provenance is a per-value field
 * (`Provenance.source`), so a silent swap would mislabel every figure on screen.
 *
 * There is deliberately NO stub/sample provider registered here. Tests inject a
 * fake through the service constructor instead, which means no environment
 * variable — and no misconfiguration — can ever put synthetic financials in
 * front of a user.
 */

export * from './fundamentals.contract';
export * from './ratios';
export * from './reconciliation';
export { TwelveDataFundamentalsProvider, clearFundamentalsMemo } from './twelvedata.fundamentals';

import { FundamentalsUnavailableError, type FinancialDataProvider } from './fundamentals.contract';
import { TwelveDataFundamentalsProvider } from './twelvedata.fundamentals';

/** Vendors this build can talk to. Extend by adding a case, not a fallback. */
export type FundamentalsProviderName = 'twelvedata';

export function resolveFinancialDataProvider(
  name: string = process.env.RESEARCH_FUNDAMENTALS_PROVIDER || 'twelvedata',
): FinancialDataProvider {
  switch (name) {
    case 'twelvedata':
      return new TwelveDataFundamentalsProvider();
    default:
      throw new FundamentalsUnavailableError(
        `RESEARCH_FUNDAMENTALS_PROVIDER="${name}" is not a provider this build knows`,
      );
  }
}
