import { describe, expect, it } from 'vitest';
import { BhavcopyShapeError, isoDay, parseBhavcopy } from './bhavcopy.parser';

/** Header and rows are verbatim from the live file, fetched 2026-08-19. */
const HEADER =
  'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER';

const RELIANCE =
  'RELIANCE, EQ, 18-Aug-2026, 1316.00, 1314.00, 1328.60, 1311.20, 1322.00, 1322.00, 1322.76, 10180567, 134664.67, 198021, 5641717, 55.42';
const GOVT_SECURITY =
  '1018GS2026, GS, 18-Aug-2026, 104.35, 104.74, 104.74, 104.74, 104.74, 104.74, 104.74, 190, 0.20, 3, 190, 100.00';

describe('parseBhavcopy', () => {
  it('parses a real equity row', () => {
    const { rows, sessionDate, skipped } = parseBhavcopy([HEADER, RELIANCE].join('\n'));
    expect(skipped).toEqual([]);
    expect(sessionDate!.toISOString()).toBe('2026-08-18T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'RELIANCE',
      series: 'EQ',
      open: 1314,
      high: 1328.6,
      low: 1311.2,
      close: 1322,
      prevClose: 1316,
      volume: 10180567,
      deliveredPct: 55.42,
    });
  });

  it('reads the session date from DATE1, not from any filename', () => {
    // THE TRAP. sec_bhavdata_full_16082026.csv (a Sunday) really does return
    // HTTP 200 carrying 14-Aug-2026 rows. A caller that stamped these bars with
    // the date it requested would create a phantom Sunday session holding a
    // duplicate of Friday — and every 52-week high/low afterwards would be
    // computed over a series with fabricated days in it.
    const friday = RELIANCE.replace('18-Aug-2026', '14-Aug-2026');
    const { sessionDate } = parseBhavcopy([HEADER, friday].join('\n'));
    expect(sessionDate!.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('excludes non-equity series', () => {
    // The file carries government securities, SME boards and more. Only EQ/BE/BZ
    // are shares, and they are exactly the three series EQUITY_L.csv publishes.
    const { rows } = parseBhavcopy([HEADER, RELIANCE, GOVT_SECURITY].join('\n'));
    expect(rows.map((r) => r.symbol)).toEqual(['RELIANCE']);
  });

  it('keeps BE and BZ, which are equity under surveillance', () => {
    const be = RELIANCE.replace(' EQ,', ' BE,').replace('RELIANCE', 'SOMEBE');
    const bz = RELIANCE.replace(' EQ,', ' BZ,').replace('RELIANCE', 'SOMEBZ');
    const { rows } = parseBhavcopy([HEADER, be, bz].join('\n'));
    expect(rows.map((r) => r.series).sort()).toEqual(['BE', 'BZ']);
  });

  it('rejects a bar whose OHLC cannot be true', () => {
    // high < low, and a close outside the range. Nothing downstream re-checks
    // this, so a corrupt bar would silently poison every range and indicator
    // derived from the series.
    const highBelowLow = RELIANCE.replace('1328.60, 1311.20', '1200.00, 1311.20');
    const closeOutside = RELIANCE.replace(', 1322.00, 1322.00, 1322.76,', ', 1900.00, 1900.00, 1322.76,');
    const { rows, skipped } = parseBhavcopy([HEADER, highBelowLow, closeOutside].join('\n'));
    expect(rows).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0].reason).toContain('inconsistent OHLC');
  });

  it('throws when one file carries more than one session date', () => {
    // Guessing which date is "the" session would be a coin flip that silently
    // mis-stamps thousands of bars.
    const other = RELIANCE.replace('18-Aug-2026', '17-Aug-2026').replace('RELIANCE', 'TCS');
    expect(() => parseBhavcopy([HEADER, RELIANCE, other].join('\n'))).toThrow(BhavcopyShapeError);
  });

  it('throws on a changed header', () => {
    const reordered = HEADER.replace('SYMBOL, SERIES', 'SERIES, SYMBOL');
    expect(() => parseBhavcopy([reordered, RELIANCE].join('\n'))).toThrow(BhavcopyShapeError);
  });

  it('throws on an empty file', () => {
    expect(() => parseBhavcopy('')).toThrow(BhavcopyShapeError);
  });

  it('reports a null session date when nothing parseable was present', () => {
    // Callers must treat this as unusable rather than defaulting to the day
    // they asked for — which is the whole point of returning it separately.
    const { sessionDate } = parseBhavcopy([HEADER, GOVT_SECURITY].join('\n'));
    expect(sessionDate).toBeNull();
  });
});

describe('isoDay', () => {
  it('formats in UTC', () => {
    expect(isoDay(new Date(Date.UTC(2026, 7, 18)))).toBe('2026-08-18');
  });
});
