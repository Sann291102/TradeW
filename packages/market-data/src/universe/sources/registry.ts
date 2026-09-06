/**
 * Which sources exist, and which of them can run right now.
 *
 * `createCatalogueSources` returns every source unconditionally; deciding
 * whether one is usable is a separate question answered by `isConfigured()`,
 * and the distinction is load-bearing. A source that cannot authenticate must
 * be reported as UNAVAILABLE and skipped — never run and observed to return
 * nothing, because "nothing" from a complete run is the signal that delists an
 * entire market.
 */

import type { CatalogueSource, UniverseMarket } from '../universe.contracts';
import { BinanceCatalogueSource } from './binance.catalogue';
import { DhanCatalogueSource, type DhanCatalogueOptions } from './dhan.catalogue';
import { TwelveDataCatalogueSource, type TwelveDataCatalogueOptions } from './twelvedata.catalogue';

export interface CatalogueSourceOptions {
  dhan?: DhanCatalogueOptions;
  twelveData?: TwelveDataCatalogueOptions;
}

export function createCatalogueSources(options: CatalogueSourceOptions = {}): CatalogueSource[] {
  return [
    new DhanCatalogueSource(options.dhan),
    new TwelveDataCatalogueSource(options.twelveData),
    new BinanceCatalogueSource(),
  ];
}

/** The sources that can populate a given market, configured or not. */
export function sourcesForMarket(sources: readonly CatalogueSource[], market: UniverseMarket): CatalogueSource[] {
  return sources.filter((s) => s.markets.includes(market));
}

export interface SourceAvailability {
  id: string;
  markets: readonly UniverseMarket[];
  configured: boolean;
  /** Why it cannot run, for an operator reading a sync report. */
  reason?: string;
}

export function describeAvailability(sources: readonly CatalogueSource[]): SourceAvailability[] {
  return sources.map((s) => ({
    id: s.id,
    markets: s.markets,
    configured: s.isConfigured(),
    reason: s.isConfigured()
      ? undefined
      : s.id === 'twelvedata'
        ? 'TWELVEDATA_API_KEY is not set — US, UK and forex catalogues cannot be synced'
        : 'source reported itself as not configured',
  }));
}
