import { describe, expect, it } from 'vitest';
import {
  fiscalQuarterOf,
  fiscalYearOf,
  frequencyFromPeriod,
  parseXbrl,
  XbrlShapeError,
} from './xbrl.parser';

/**
 * The fixture reproduces the exact structure of RELIANCE's Q3 FY25 filing
 * (INDAS_117298_1348254_16012025082021.xml), including the defect that makes
 * this parser necessary: context `FourD` declares the same three-month period
 * as `OneD` while its reporting-period facts say nine months, and its values
 * are the nine-month ones.
 */
const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin">
  <xbrli:context id="OneD">
    <xbrli:entity><xbrli:identifier scheme="http://www.nseindia.com/NSESymbol">RELIANCE</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2024-10-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="FourD">
    <xbrli:entity><xbrli:identifier scheme="http://www.nseindia.com/NSESymbol">RELIANCE</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2024-10-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="OneI">
    <xbrli:entity><xbrli:identifier scheme="http://www.nseindia.com/NSESymbol">RELIANCE</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>2024-12-31</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:context id="OneReportableSegmentRevenue01D">
    <xbrli:entity><xbrli:identifier scheme="x">RELIANCE</xbrli:identifier>
      <xbrli:segment><xbrldi:explicitMember dimension="in-bse-fin:ReportableSegmentsAxis">in-bse-fin:OneReportableSegmentRevenue01Member</xbrldi:explicitMember></xbrli:segment>
    </xbrli:entity>
    <xbrli:period><xbrli:startDate>2024-10-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period>
  </xbrli:context>

  <in-bse-fin:Symbol contextRef="OneD">RELIANCE</in-bse-fin:Symbol>
  <in-bse-fin:ISIN contextRef="OneD">INE002A01018</in-bse-fin:ISIN>
  <in-bse-fin:NameOfTheCompany contextRef="OneD">Reliance Industries Limited</in-bse-fin:NameOfTheCompany>

  <in-bse-fin:DateOfStartOfReportingPeriod contextRef="OneD">2024-10-01</in-bse-fin:DateOfStartOfReportingPeriod>
  <in-bse-fin:DateOfEndOfReportingPeriod contextRef="OneD">2024-12-31</in-bse-fin:DateOfEndOfReportingPeriod>
  <in-bse-fin:NatureOfReportStandaloneConsolidated contextRef="OneD">Standalone</in-bse-fin:NatureOfReportStandaloneConsolidated>
  <in-bse-fin:WhetherResultsAreAuditedOrUnaudited contextRef="OneD">Unaudited</in-bse-fin:WhetherResultsAreAuditedOrUnaudited>

  <in-bse-fin:DateOfStartOfReportingPeriod contextRef="FourD">2024-04-01</in-bse-fin:DateOfStartOfReportingPeriod>
  <in-bse-fin:DateOfEndOfReportingPeriod contextRef="FourD">2024-12-31</in-bse-fin:DateOfEndOfReportingPeriod>
  <in-bse-fin:NatureOfReportStandaloneConsolidated contextRef="FourD">Standalone</in-bse-fin:NatureOfReportStandaloneConsolidated>

  <in-bse-fin:RevenueFromOperations contextRef="OneD" unitRef="INR">1282600000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:ProfitBeforeTax contextRef="OneD" unitRef="INR">115970000000.00</in-bse-fin:ProfitBeforeTax>
  <in-bse-fin:RevenueFromOperations contextRef="FourD" unitRef="INR">3966450000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:ProfitBeforeTax contextRef="FourD" unitRef="INR">319570000000.00</in-bse-fin:ProfitBeforeTax>
  <in-bse-fin:Assets contextRef="OneI" unitRef="INR">1750000000000.00</in-bse-fin:Assets>
  <in-bse-fin:SegmentRevenue contextRef="OneReportableSegmentRevenue01D" unitRef="INR">999999999.00</in-bse-fin:SegmentRevenue>
  <in-bse-fin:DescriptionOfOtherExpenses contextRef="OneD">Sundry</in-bse-fin:DescriptionOfOtherExpenses>
</xbrli:xbrl>`;

describe('parseXbrl', () => {
  it('extracts identity from the document itself', () => {
    const doc = parseXbrl(DOC);
    expect(doc.symbol).toBe('RELIANCE');
    expect(doc.isin).toBe('INE002A01018');
    expect(doc.companyName).toBe('Reliance Industries Limited');
  });

  it('takes the period from the reporting-period FACTS, not the context', () => {
    // THE BUG THIS PARSER EXISTS TO PREVENT. FourD's context claims Oct-Dec;
    // its facts say Apr-Dec, and its revenue is the nine-month figure. Trusting
    // the context would file nine months of revenue as one quarter — ~3x too
    // large — without anything throwing.
    const doc = parseXbrl(DOC);
    const four = doc.columns.find((c) => c.contextId === 'FourD')!;
    expect(four.periodStart.toISOString().slice(0, 10)).toBe('2024-04-01');
    expect(four.periodEnd.toISOString().slice(0, 10)).toBe('2024-12-31');
    expect(four.contextPeriodDisagreed).toBe(true);

    const one = doc.columns.find((c) => c.contextId === 'OneD')!;
    expect(one.periodStart.toISOString().slice(0, 10)).toBe('2024-10-01');
    expect(one.contextPeriodDisagreed).toBe(false);
  });

  it('keeps the two columns separate with their own values', () => {
    const doc = parseXbrl(DOC);
    const revenue = (ctx: string) =>
      doc.columns.find((c) => c.contextId === ctx)!.facts.find((f) => f.tag === 'RevenueFromOperations')!.value;
    expect(revenue('OneD')).toBe(1_282_600_000_000);
    expect(revenue('FourD')).toBe(3_966_450_000_000);
    // Sanity on the ratio that proves FourD is nine months, not three.
    expect(revenue('FourD') / revenue('OneD')).toBeGreaterThan(2.5);
  });

  it('excludes dimensioned contexts from every column', () => {
    // Segment revenue is a disaggregation of a line already present. Reading it
    // as a statement line reports one segment's revenue as the company's;
    // summing them double-counts.
    const doc = parseXbrl(DOC);
    const allTags = doc.columns.flatMap((c) => c.facts.map((f) => f.tag));
    expect(allTags).not.toContain('SegmentRevenue');
    expect(doc.dimensionedTagCount).toBe(1);
  });

  it('drops non-numeric facts rather than coercing them to zero', () => {
    // Number('') is 0. Without the guard, a descriptive tag becomes a confident
    // zero in the statement.
    const doc = parseXbrl(DOC);
    const tags = doc.columns.flatMap((c) => c.facts.map((f) => f.tag));
    expect(tags).not.toContain('DescriptionOfOtherExpenses');
  });

  it('separates instant contexts, which are balance-sheet dates', () => {
    const doc = parseXbrl(DOC);
    expect(doc.instants).toHaveLength(1);
    expect(doc.instants[0].instant.toISOString().slice(0, 10)).toBe('2024-12-31');
    expect(doc.instants[0].facts[0]).toEqual({ tag: 'Assets', value: 1_750_000_000_000 });
  });

  it('reads consolidation from the filing rather than inferring it', () => {
    const doc = parseXbrl(DOC);
    expect(doc.columns.every((c) => c.consolidation === 'STANDALONE')).toBe(true);
  });

  it('rejects a document that is not XBRL', () => {
    expect(() => parseXbrl('<html><body>Access Denied</body></html>')).toThrow(XbrlShapeError);
  });

  it('rejects an XBRL document with no usable facts', () => {
    const empty = DOC.replace(/<in-bse-fin:(RevenueFromOperations|ProfitBeforeTax|Assets|SegmentRevenue)[\s\S]*?>/g, '');
    expect(() => parseXbrl(empty)).toThrow(XbrlShapeError);
  });
});

describe('frequencyFromPeriod', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);

  it('classifies by length, not by label', () => {
    // The cumulative column of a Q3 filing still says "Third quarter", so the
    // label cannot be trusted — the same trap as the context period, by another
    // door.
    expect(frequencyFromPeriod(d('2024-10-01'), d('2024-12-31'))).toBe('Q');
    expect(frequencyFromPeriod(d('2024-04-01'), d('2024-12-31'))).toBe('9M');
    expect(frequencyFromPeriod(d('2024-04-01'), d('2024-09-30'))).toBe('H');
    expect(frequencyFromPeriod(d('2023-04-01'), d('2024-03-31'))).toBe('A');
  });

  it('tolerates filers whose boundaries wobble', () => {
    expect(frequencyFromPeriod(d('2024-01-01'), d('2024-03-31'))).toBe('Q'); // 91d
    expect(frequencyFromPeriod(d('2024-02-01'), d('2024-04-30'))).toBe('Q'); // 90d
    expect(frequencyFromPeriod(d('2023-04-01'), d('2024-03-31'))).toBe('A'); // 366d leap
  });

  it('returns null for a period that matches nothing, rather than guessing', () => {
    expect(frequencyFromPeriod(d('2024-01-01'), d('2024-02-15'))).toBeNull();
    expect(frequencyFromPeriod(d('2024-01-01'), d('2026-01-01'))).toBeNull();
  });
});

describe('fiscalYearOf / fiscalQuarterOf', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);

  it('labels the Indian fiscal year by the calendar year it ends in', () => {
    expect(fiscalYearOf(d('2024-12-31'))).toBe(2025); // Q3 FY25
    expect(fiscalYearOf(d('2025-03-31'))).toBe(2025); // Q4 FY25
    expect(fiscalYearOf(d('2025-04-30'))).toBe(2026); // first month of FY26
    expect(fiscalYearOf(d('2025-06-30'))).toBe(2026); // Q1 FY26
  });

  it('numbers quarters from April, and only for quarterly periods', () => {
    expect(fiscalQuarterOf(d('2024-06-30'), 'Q')).toBe(1);
    expect(fiscalQuarterOf(d('2024-09-30'), 'Q')).toBe(2);
    expect(fiscalQuarterOf(d('2024-12-31'), 'Q')).toBe(3);
    expect(fiscalQuarterOf(d('2025-03-31'), 'Q')).toBe(4);
    // A nine-month or annual period has no quarter number, and inventing one
    // would let it be charted as though it were a quarter.
    expect(fiscalQuarterOf(d('2024-12-31'), '9M')).toBeNull();
    expect(fiscalQuarterOf(d('2025-03-31'), 'A')).toBeNull();
  });
});
