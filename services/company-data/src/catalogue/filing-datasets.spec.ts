import { describe, expect, it } from 'vitest';
import {
  buildUrl,
  FILING_DATASET_IDS,
  FILING_DATASETS,
  InvalidScopeError,
  isAllowedDocumentUrl,
  resolveDataset,
  SYMBOL_PATTERN,
} from './filing-datasets';

/**
 * The catalogue is the security boundary of this service: it is the only place
 * an outbound URL is composed, and the scope value is the only part a caller
 * influences. These tests pin that boundary, not the convenience of the API.
 */

describe('resolveDataset', () => {
  it('resolves every declared dataset', () => {
    for (const id of FILING_DATASET_IDS) {
      expect(resolveDataset(id)?.id).toBe(id);
    }
  });

  it('returns undefined for anything not declared — no prefix match, no fallback', () => {
    expect(resolveDataset('nse.')).toBeUndefined();
    expect(resolveDataset('nse.announcements.extra')).toBeUndefined();
    expect(resolveDataset('')).toBeUndefined();
    expect(resolveDataset('nse.quote-equity')).toBeUndefined();
  });

  it('does not resolve inherited Object properties', () => {
    // `id in FILING_DATASETS` would answer true for these; hasOwnProperty does
    // not. A catalogue that resolves 'constructor' to a function is a bug with
    // an outbound request on the end of it.
    expect(resolveDataset('constructor')).toBeUndefined();
    expect(resolveDataset('__proto__')).toBeUndefined();
    expect(resolveDataset('toString')).toBeUndefined();
  });
});

describe('buildUrl — symbol datasets', () => {
  const announcements = FILING_DATASETS['nse.announcements'];

  it('builds the verified URL shape', () => {
    expect(buildUrl(announcements, 'RELIANCE')).toBe(
      'https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=RELIANCE',
    );
  });

  it('encodes symbols that contain URL-significant characters', () => {
    // M&M is a real NSE symbol. Unencoded, the `&` would end the symbol
    // parameter and start a new one — the request would silently be for "M".
    expect(buildUrl(announcements, 'M&M')).toContain('symbol=M%26M');
    expect(buildUrl(announcements, 'M&M')).not.toContain('symbol=M&M');
  });

  it('accepts the real-world symbol shapes from EQUITY_L.csv', () => {
    for (const symbol of ['RELIANCE', 'M&M', 'BAJAJ-AUTO', 'IDEA', '360ONE']) {
      expect(SYMBOL_PATTERN.test(symbol)).toBe(true);
      expect(() => buildUrl(announcements, symbol)).not.toThrow();
    }
  });

  it('refuses a scope that is not a symbol rather than encoding it', () => {
    // Validate-then-encode. Encoding alone would turn every one of these into a
    // perfectly well-formed request for something we never meant to fetch.
    const hostile = [
      '../../../etc/passwd',
      'RELIANCE&period=Annual',
      'https://evil.example.com/',
      'RELIANCE#fragment',
      'RELIANCE?x=1',
      'reliance', // lower case is not how NSE spells symbols
      'A'.repeat(33),
      '',
    ];
    for (const scope of hostile) {
      expect(() => buildUrl(announcements, scope)).toThrow(InvalidScopeError);
    }
  });

  it('requires a symbol', () => {
    expect(() => buildUrl(announcements)).toThrow(InvalidScopeError);
  });
});

describe('buildUrl — market datasets', () => {
  const list = FILING_DATASETS['nse.equity-list'];

  it('needs no scope', () => {
    expect(buildUrl(list)).toBe('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
    expect(buildUrl(list, 'market')).toBe('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
  });

  it('rejects a symbol rather than ignoring it', () => {
    // Silently dropping the argument would leave a caller believing it had
    // fetched one company's data when it had fetched the whole exchange.
    expect(() => buildUrl(list, 'RELIANCE')).toThrow(InvalidScopeError);
  });
});

describe('catalogue invariants', () => {
  it('every dataset builds an https URL on its declared host', () => {
    for (const id of FILING_DATASET_IDS) {
      const dataset = FILING_DATASETS[id];
      const url = new URL(buildUrl(dataset, dataset.scope === 'symbol' ? 'RELIANCE' : undefined));
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe(dataset.host);
    }
  });

  it('declares a positive cadence for every dataset', () => {
    // A zero or negative cadence would make the scheduler re-run a job forever.
    for (const id of FILING_DATASET_IDS) {
      expect(FILING_DATASETS[id].cadenceMs).toBeGreaterThan(0);
    }
  });

  it('flags the datasets that carry company-authored prose', () => {
    // These are the payloads whose text must never reach a model as
    // instruction. If a future edit clears one of these flags, that is a
    // decision to be made deliberately, not silently.
    expect(FILING_DATASETS['nse.announcements'].carriesProse).toBe(true);
    expect(FILING_DATASETS['nse.board-meetings'].carriesProse).toBe(true);
    expect(FILING_DATASETS['nse.shareholding'].carriesProse).toBe(true);
    expect(FILING_DATASETS['nse.equity-list'].carriesProse).toBe(false);
  });

  it('does not contain quote-equity, which is 403 to this client', () => {
    // Verified 2026-08-19. Pinned so a future edit does not reintroduce it and
    // quietly make market cap depend on an endpoint that refuses us.
    expect(FILING_DATASET_IDS.some((id) => id.includes('quote'))).toBe(false);
  });
});

describe('isAllowedDocumentUrl', () => {
  it('allows the archive hosts NSE actually serves filings from', () => {
    expect(
      isAllowedDocumentUrl('https://nsearchives.nseindia.com/corporate/xbrl/INDAS_117298_1348254_16012025082021.xml'),
    ).toBe(true);
    expect(isAllowedDocumentUrl('https://archives.nseindia.com/content/equities/EQUITY_L.csv')).toBe(true);
  });

  it('refuses a look-alike host', () => {
    // The classic form of this bug is endsWith('nseindia.com'), which matches
    // both of these. Host equality does not.
    expect(isAllowedDocumentUrl('https://evilnseindia.com/x.xml')).toBe(false);
    expect(isAllowedDocumentUrl('https://nseindia.com.evil.example/x.xml')).toBe(false);
  });

  it('refuses non-https and unparseable URLs', () => {
    expect(isAllowedDocumentUrl('http://nsearchives.nseindia.com/x.xml')).toBe(false);
    expect(isAllowedDocumentUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedDocumentUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedDocumentUrl('not a url')).toBe(false);
    expect(isAllowedDocumentUrl('')).toBe(false);
  });
});
