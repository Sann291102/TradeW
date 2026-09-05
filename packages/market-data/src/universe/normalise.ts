/**
 * Normalisation and de-duplication — the step between a provider's page and a
 * database row.
 *
 * Two jobs, both of which have to happen before anything is written:
 *
 *  1. NORMALISE. Upper-case the ticker, trim the name, resolve the currency
 *     policy, compute the ref and the search text. Doing this here rather than
 *     in each source is what keeps the three adapters honest — a source cannot
 *     accidentally invent its own symbol casing or skip the currency rules.
 *
 *  2. DE-DUPLICATE, deterministically. Duplicates are not hypothetical: Twelve
 *     Data's `/stocks` and `/etf` feeds overlap on some lines, an exchange
 *     alias can be queried under two names, and a provider occasionally emits
 *     the same ticker twice across a data migration. The winner is decided by a
 *     stated preference order and the loser is COUNTED, not silently dropped,
 *     so a sudden rise in duplicates is visible as a number.
 */

import { resolveCurrencyPolicy } from './currency-policy';
import {
  buildSearchText,
  universeRef,
  type CatalogueRecord,
  type UniverseAssetClass,
} from './universe.contracts';

/** A record with everything the database column set needs, nothing missing. */
export interface NormalisedRecord extends CatalogueRecord {
  ref: string;
  accountCurrency: string;
  requiresFxConversion: boolean;
  searchText: string;
}

export function normalise(record: CatalogueRecord): NormalisedRecord {
  const symbol = record.symbol.trim().toUpperCase();
  const policy = resolveCurrencyPolicy({
    market: record.market,
    exchange: record.exchange,
    providerCurrency: record.quoteCurrency,
    quoteAsset: record.quoteAsset,
  });

  const cleaned: CatalogueRecord = {
    ...record,
    symbol,
    displayName: (record.displayName || symbol).trim().slice(0, 240),
    quoteCurrency: policy.quoteCurrency,
    isin: blankToUndefined(record.isin),
    figi: blankToUndefined(record.figi),
    cusip: blankToUndefined(record.cusip),
    sedol: blankToUndefined(record.sedol),
    country: blankToUndefined(record.country),
    providerSymbol: (record.providerSymbol || symbol).trim(),
  };

  return {
    ...cleaned,
    ref: universeRef(cleaned),
    accountCurrency: policy.accountCurrency,
    requiresFxConversion: policy.requiresFxConversion,
    searchText: buildSearchText(cleaned),
  };
}

/**
 * Preference between two records claiming the same (market, exchange, symbol).
 *
 * Ordered by how much a wrong choice costs:
 *
 *  1. A record with a real status beats one that says UNKNOWN — knowing an
 *     instrument is suspended matters more than any other field on it.
 *  2. A more specific asset class beats OTHER. An ETF row from `/etf` and an
 *     EQUITY row from `/stocks` for the same ticker: the specific feed is the
 *     one that knows what it is looking at.
 *  3. More identifiers (ISIN, FIGI, CUSIP, SEDOL) beats fewer — those are what
 *     let this row be joined to fundamentals and news later.
 *  4. Failing all of that, the incumbent stays. Stability beats churn: a
 *     coin-flip that alternated between two equally-good rows would rewrite the
 *     table on every sync.
 */
export function preferRecord(incumbent: NormalisedRecord, challenger: NormalisedRecord): NormalisedRecord {
  const knownStatus = (r: NormalisedRecord) => (r.status === 'UNKNOWN' ? 0 : 1);
  if (knownStatus(challenger) !== knownStatus(incumbent)) {
    return knownStatus(challenger) > knownStatus(incumbent) ? challenger : incumbent;
  }

  const specificity = (c: UniverseAssetClass) => (c === 'OTHER' ? 0 : 1);
  if (specificity(challenger.assetClass) !== specificity(incumbent.assetClass)) {
    return specificity(challenger.assetClass) > specificity(incumbent.assetClass) ? challenger : incumbent;
  }

  const ids = (r: NormalisedRecord) => [r.isin, r.figi, r.cusip, r.sedol].filter(Boolean).length;
  if (ids(challenger) !== ids(incumbent)) return ids(challenger) > ids(incumbent) ? challenger : incumbent;

  return incumbent;
}

export interface DedupeResult {
  records: NormalisedRecord[];
  duplicates: number;
}

/**
 * Collapse a batch onto one row per `ref`.
 *
 * Note this de-duplicates WITHIN a batch. Cross-batch and cross-run identity is
 * the database's job — `ref` is unique there — which is the right place for it:
 * a sync that streams pages cannot hold every ref it has ever seen in memory
 * and still be honest about a 200k-row catalogue.
 */
export function dedupe(records: readonly NormalisedRecord[]): DedupeResult {
  const byRef = new Map<string, NormalisedRecord>();
  let duplicates = 0;

  for (const record of records) {
    const existing = byRef.get(record.ref);
    if (!existing) {
      byRef.set(record.ref, record);
      continue;
    }
    duplicates++;
    byRef.set(record.ref, preferRecord(existing, record));
  }

  return { records: [...byRef.values()], duplicates };
}

function blankToUndefined(v: string | undefined): string | undefined {
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}
