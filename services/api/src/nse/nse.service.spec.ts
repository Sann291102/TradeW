import { describe, expect, it } from 'vitest';
import { parseParticipantOi } from './nse.service';

/**
 * The participant-OI report is the derivatives half of "what are institutions
 * doing", and it arrives as a CSV whose headers carry trailing whitespace and
 * whose first line is a title rather than data. Every failure mode here is a
 * confident number attributed to the wrong participant or the wrong column.
 *
 * The fixture is the real file, byte-for-byte as returned by
 * archives.nseindia.com on 2026-08-16 for the 14-Aug-2026 session — including
 * the doubled quotes on the title line and the padded headers.
 */

const REAL_CSV = [
  '""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Aug 14, 2026"",,,,,,,,,,,,,,',
  'Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts      ,Total Short Contracts',
  'Client,211638,55956,3275125,261974,3205535,2649873,3072956,3257565,2832221,977719,1540281,1301705,13152111,9490438',
  'DII,50830,20040,329392,4402412,7380,50603,130,0,928,40785,352194,19703,479918,4794479',
  'FII,25537,202235,3535257,2910988,537355,975053,814000,477877,216502,378403,415544,211113,5668106,5031758',
  '',
].join('\n');

describe('parseParticipantOi', () => {
  it('reads the session out of the title line', () => {
    // The date is not in any column — losing it would leave the numbers
    // undated, which for an end-of-day report is the whole context.
    expect(parseParticipantOi(REAL_CSV).session).toBe('Aug 14, 2026');
  });

  it('reads every participant row', () => {
    expect(parseParticipantOi(REAL_CSV).rows.map((r) => r.participant)).toEqual(['Client', 'DII', 'FII']);
  });

  it('matches columns by name despite the padding in the real header', () => {
    // "Future Stock Short       " and "Total Long Contracts      " ship with
    // trailing spaces. An untrimmed name-based lookup misses silently and
    // returns null for a column that is right there.
    const fii = parseParticipantOi(REAL_CSV).rows.find((r) => r.participant === 'FII')!;
    expect(fii.totalLong).toBe(5668106);
    expect(fii.totalShort).toBe(5031758);
  });

  it('preserves the index-futures skew that makes this report worth reading', () => {
    const fii = parseParticipantOi(REAL_CSV).rows.find((r) => r.participant === 'FII')!;
    expect(fii.futureIndexLong).toBe(25537);
    expect(fii.futureIndexShort).toBe(202235);
    // ~8x more short than long — the positioning fact a cash-flow number
    // cannot express.
    expect(fii.futureIndexShort! / fii.futureIndexLong!).toBeGreaterThan(7);
  });

  it('does not confuse one participant s row with another s', () => {
    const rows = parseParticipantOi(REAL_CSV).rows;
    expect(rows.find((r) => r.participant === 'DII')!.futureIndexLong).toBe(50830);
    expect(rows.find((r) => r.participant === 'Client')!.futureIndexLong).toBe(211638);
  });

  it('returns nothing rather than guessing when the file is truncated', () => {
    expect(parseParticipantOi('').rows).toEqual([]);
    expect(parseParticipantOi('just a title line').rows).toEqual([]);
  });

  it('survives a missing column instead of shifting every value left', () => {
    // If NSE drops or renames a column, the named lookup yields null for that
    // field and every other field stays correct. An index-based reader would
    // silently report the neighbouring column's number.
    const csv = [
      '""Participant wise Open Interest as on Aug 14, 2026"",,',
      'Client Type,Future Index Long,Total Long Contracts',
      'FII,25537,5668106',
    ].join('\n');
    const fii = parseParticipantOi(csv).rows[0];
    expect(fii.futureIndexLong).toBe(25537);
    expect(fii.totalLong).toBe(5668106);
    expect(fii.futureIndexShort).toBeNull();
  });

  it('reads CRLF line endings', () => {
    expect(parseParticipantOi(REAL_CSV.replace(/\n/g, '\r\n')).rows).toHaveLength(3);
  });

  it('reports an unparseable cell as null, never as zero', () => {
    // Zero is a position. "No value published" is not, and coercing one into
    // the other reports an institution as flat when it is unknown.
    const csv = [
      '""x as on Aug 14, 2026"",,',
      'Client Type,Future Index Long,Total Long Contracts',
      'FII,-,5668106',
    ].join('\n');
    expect(parseParticipantOi(csv).rows[0].futureIndexLong).toBeNull();
  });
});
