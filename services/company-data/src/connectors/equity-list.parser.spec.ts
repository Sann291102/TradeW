import { describe, expect, it } from 'vitest';
import {
  choosePrimaryListing,
  EquityListShapeError,
  isValidIsin,
  normalizeIdentifier,
  parseEquityList,
  parseNseDate,
  parseNumber,
  securityKindFromIsin,
  splitCsvLine,
} from './equity-list.parser';

/**
 * Fixtures are verbatim from the live file (fetched 2026-08-19), not invented.
 * The header in particular is copied exactly — including the leading space on
 * every column after the first, which is the documented way to fail on this
 * feed.
 */
const HEADER = 'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE';
const REAL_ROWS = [
  '20MICRONS,20 Microns Limited,EQ,06-OCT-2008,5,1,INE144J01027,5',
  '21STCENMGM,21st Century Management Services Limited,EQ,03-MAY-1995,10,1,INE253B01015,10',
  '360ONE,360 ONE WAM LIMITED,EQ,19-SEP-2019,1,1,INE466L01038,1',
];

describe('parseEquityList', () => {
  it('parses the real file shape', () => {
    const { rows, skipped } = parseEquityList([HEADER, ...REAL_ROWS].join('\n'));
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      symbol: '20MICRONS',
      name: '20 Microns Limited',
      series: 'EQ',
      listedOn: new Date(Date.UTC(2008, 9, 6)),
      paidUpValue: 5,
      marketLot: 1,
      isin: 'INE144J01027',
      faceValue: 5,
    });
  });

  it('tolerates CRLF and a trailing blank line', () => {
    const { rows } = parseEquityList([HEADER, ...REAL_ROWS].join('\r\n') + '\r\n');
    expect(rows).toHaveLength(3);
  });

  it('throws when the header changes rather than parsing by position', () => {
    // Positional parsing of a reordered file does not throw — names land in the
    // series column and every row still "parses". The header check is the only
    // thing standing between a reshaped upstream and plausible nonsense.
    const reordered = 'SYMBOL,SERIES,NAME OF COMPANY, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE';
    expect(() => parseEquityList([reordered, ...REAL_ROWS].join('\n'))).toThrow(EquityListShapeError);
  });

  it('throws on an empty file', () => {
    expect(() => parseEquityList('')).toThrow(EquityListShapeError);
    expect(() => parseEquityList('\n\n')).toThrow(EquityListShapeError);
  });

  it('reports unusable rows instead of dropping them silently', () => {
    // A parser that silently drops rows yields a company list that is wrong in
    // a way nothing downstream can detect.
    const csv = [
      HEADER,
      REAL_ROWS[0],
      'BROKEN,Only Three Fields,EQ',
      ',No Symbol Ltd,EQ,01-JAN-2020,1,1,INE111A01011,1',
      'BADISIN,Bad Isin Limited,EQ,01-JAN-2020,1,1,XX123,1',
    ].join('\n');

    const { rows, skipped } = parseEquityList(csv);
    expect(rows).toHaveLength(1);
    expect(skipped).toHaveLength(3);
    expect(skipped[0].reason).toContain('expected 8 fields');
    expect(skipped[1].reason).toBe('missing symbol');
    expect(skipped[2].reason).toContain('invalid ISIN');
    // Line numbers are 1-based against the file, so a report is actionable.
    expect(skipped[0].line).toBe(3);
  });

  it('keeps fields aligned when a company name contains a comma', () => {
    // Not in the file today. When it appears, a plain split(',') shifts every
    // later field by one and the ISIN check starts rejecting rows for no
    // visible reason.
    const csv = [HEADER, '"ACME","Acme Holdings, Limited",EQ,01-JAN-2020,10,1,INE999Z01011,10'].join('\n');
    const { rows, skipped } = parseEquityList(csv);
    expect(skipped).toEqual([]);
    expect(rows[0].name).toBe('Acme Holdings, Limited');
    expect(rows[0].isin).toBe('INE999Z01011');
  });
});

describe('splitCsvLine', () => {
  it('handles quotes and escaped quotes', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
    expect(splitCsvLine('"say ""hi""",c')).toEqual(['say "hi"', 'c']);
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseNseDate', () => {
  it('parses the exchange format as a calendar day in UTC', () => {
    // Constructed in UTC deliberately: a listing date is a day, not an instant,
    // and building it locally shifts it across a day boundary for every user
    // east of UTC — which is all of them.
    const d = parseNseDate('06-OCT-2008')!;
    expect(d.toISOString()).toBe('2008-10-06T00:00:00.000Z');
    expect(parseNseDate('3-MAY-1995')!.toISOString()).toBe('1995-05-03T00:00:00.000Z');
    expect(parseNseDate('19-sep-2019')!.toISOString()).toBe('2019-09-19T00:00:00.000Z');
  });

  it('returns null rather than a rolled-over date for an impossible day', () => {
    expect(parseNseDate('31-FEB-2020')).toBeNull();
    expect(parseNseDate('')).toBeNull();
    expect(parseNseDate('2008-10-06')).toBeNull();
    expect(parseNseDate('06-XXX-2008')).toBeNull();
  });
});

describe('parseNumber', () => {
  it('returns null, never 0, for absent values', () => {
    // 0 is a claim about the world; absence is not. Coercing "-" to 0 would
    // make a missing face value look like a real one.
    expect(parseNumber('-')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('  ')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber('1,000')).toBe(1000);
    expect(parseNumber('2.5')).toBe(2.5);
  });
});

describe('isValidIsin / securityKindFromIsin', () => {
  it('accepts real Indian ISINs', () => {
    expect(isValidIsin('INE002A01018')).toBe(true);
    expect(isValidIsin('INF769K01HS7')).toBe(true);
  });

  it('rejects malformed ones', () => {
    expect(isValidIsin('XX123')).toBe(false);
    expect(isValidIsin('INE002A0101')).toBe(false); // too short
    expect(isValidIsin('INE002A010188')).toBe(false); // too long
    expect(isValidIsin('')).toBe(false);
  });

  it('separates company equity from fund units', () => {
    // The check that stops an ETF being rendered with a P&L.
    expect(securityKindFromIsin('INE002A01018')).toBe('EQUITY'); // RELIANCE
    expect(securityKindFromIsin('INF769K01HS7')).toBe('FUND'); // Mirae ETF
    expect(securityKindFromIsin('IN9002A01018')).toBe('EQUITY_VARIANT');
    expect(securityKindFromIsin('US0378331005')).toBe('UNKNOWN');
  });
});

describe('normalizeIdentifier', () => {
  it('is stable across the shapes a user or a source might supply', () => {
    // Must be applied identically on write and on search: a normalisation that
    // differs between the two gives a unique index that permits duplicates and
    // a search that misses them.
    expect(normalizeIdentifier('  reliance  ')).toBe('RELIANCE');
    expect(normalizeIdentifier('Reliance   Industries\tLimited')).toBe('RELIANCE INDUSTRIES LIMITED');
    expect(normalizeIdentifier('ine002a01018')).toBe('INE002A01018');
  });
});

describe('choosePrimaryListing', () => {
  const row = (symbol: string, isin: string): any => ({ symbol, isin, name: 'X', series: 'EQ' });

  it('prefers ordinary equity over a DVR share of the same issuer', () => {
    // Jain Irrigation, the case that motivated this. JISLDVREQS sorts FIRST
    // alphabetically, so an order-dependent choice would make the
    // differential-voting-rights share the company's default listing — and its
    // price the one shown on the research page.
    const group = [row('JISLDVREQS', 'IN9175A01010'), row('JISLJALEQS', 'INE175A01038')];
    expect(choosePrimaryListing(group).symbol).toBe('JISLJALEQS');
    expect(choosePrimaryListing([...group].reverse()).symbol).toBe('JISLJALEQS');
  });

  it('breaks a same-prefix tie on the shorter symbol', () => {
    // GATECH/GATECHDVR are both INE, so the ISIN prefix cannot separate them.
    const group = [row('GATECHDVR', 'INE224E01036'), row('GATECH', 'INE224E01028')];
    expect(choosePrimaryListing(group).symbol).toBe('GATECH');
  });

  it('is deterministic regardless of input order', () => {
    const group = [row('AAA', 'INE111A01011'), row('BBB', 'INE222A01011')];
    expect(choosePrimaryListing(group).symbol).toBe(choosePrimaryListing([...group].reverse()).symbol);
  });

  it('handles a single-listing company', () => {
    expect(choosePrimaryListing([row('RELIANCE', 'INE002A01018')]).symbol).toBe('RELIANCE');
  });
});
