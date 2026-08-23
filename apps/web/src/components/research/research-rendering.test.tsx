import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatementTable } from './StatementTable';
import { ReconciliationBanner } from './ReconciliationBanner';
import { RatiosSection } from './RatiosSection';
import { HistoryChart } from './HistoryChart';
import { CompanyHeader } from './CompanyHeader';
import { OwnershipPanel, SegmentsPanel } from './OwnershipPanel';
import { DataUnavailable, NotReported } from './DataUnavailable';
import type {
  FinancialFact,
  FinancialStatement,
  ResearchSection,
  StatementPeriod,
} from '@/lib/research/types';

/**
 * What the research components put on screen.
 *
 * ── THE PROPERTY UNDER TEST ────────────────────────────────────────────────
 *
 * A number appears on the research page ONLY if it was in the data. Every test
 * below drives a component with data that is missing something, and asserts that
 * the gap renders as an absence rather than as a zero, a dash, or a borrowed
 * neighbour.
 *
 * That is the exact failure the old page shipped: constants that rendered
 * identically whatever the state, which is why they survived every review. A
 * render test that only exercises the happy path would not have caught it, so
 * these lead with the unhappy ones.
 *
 * `renderToStaticMarkup` rather than a DOM harness: these assertions are about
 * OUTPUT, not interaction, and the repo's existing component tests
 * (SentinelChartReading, StrategyConditionsPanel) use the same approach.
 */

const PROV = { source: 'twelvedata', sourceTimestamp: '2026-03-31', fetchedAt: '2026-08-23T10:00:00.000Z' };

function fact(metric: string, value: number, basis: 'reported' | 'derived' = 'reported'): FinancialFact {
  return { metric, value, currency: 'INR', basis, provenance: PROV };
}

function period(facts: Record<string, FinancialFact>, year = 2026): StatementPeriod {
  return {
    fiscalYear: year,
    periodEnd: `${year}-03-31`,
    periodType: 'annual',
    currency: 'INR',
    facts,
  };
}

function statement(periods: StatementPeriod[]): FinancialStatement {
  return { statementType: 'income', periodType: 'annual', symbol: 'TESTCO', periods };
}

// ─────────────────────────── absence, everywhere ────────────────────────────

describe('missing data never becomes a number', () => {
  it('renders "not reported" for a metric one period omits, and the value for the one that has it', () => {
    const html = renderToStaticMarkup(
      <StatementTable
        type="income"
        statement={statement([
          period({ revenue: fact('revenue', 1000), net_income: fact('net_income', 120) }, 2026),
          period({ revenue: fact('revenue', 900) }, 2025), // net income absent
        ])}
      />,
    );

    expect(html).toContain('not reported');
    expect(html).toContain('1,000');
    // The absent 2025 net income must NOT have become a zero.
    expect(html).not.toMatch(/>0<|>0\.00</);
  });

  it('drops a line no period reports rather than showing an empty row', () => {
    const html = renderToStaticMarkup(
      <StatementTable type="income" statement={statement([period({ revenue: fact('revenue', 1000) })])} />,
    );
    // Goodwill etc. belong to the balance sheet; EBITDA is an income line that
    // this company did not file. An empty row across every column reads as a
    // row of zeros, so the line is omitted entirely.
    expect(html).not.toContain('EBITDA');
    expect(html).toContain('Revenue');
  });

  it('marks a derived value as derived', () => {
    const html = renderToStaticMarkup(
      <StatementTable
        type="income"
        statement={statement([period({ operating_expenses: fact('operating_expenses', 230, 'derived') })])}
      />,
    );
    expect(html).toContain('aria-label="derived"');
    expect(html).toContain('derived by TradeW');
  });

  it('renders accounting negatives in parentheses', () => {
    const html = renderToStaticMarkup(
      <StatementTable type="income" statement={statement([period({ net_income: fact('net_income', -450) })])} />,
    );
    expect(html).toContain('(450');
  });

  it('shows the company header with absences instead of substituted figures', () => {
    const html = renderToStaticMarkup(
      <CompanyHeader
        overview={{
          available: true,
          provenance: PROV,
          data: {
            profile: {
              symbol: 'TESTCO',
              exchange: 'NSE',
              name: 'Testco Industries',
              currency: 'INR',
              provenance: PROV,
              // sector, industry, country, description all absent
            },
            statistics: {
              symbol: 'TESTCO',
              currency: 'INR',
              marketCap: 19_310_000_000_000,
              provenance: PROV,
              // enterprise value, 52w range, beta, dividend yield all absent
            },
          },
        }}
      />,
    );

    expect(html).toContain('Testco Industries');
    expect(html).toContain('19,31,000 Cr'); // INR crore grouping
    // Every absent statistic renders as an absence.
    expect((html.match(/not reported/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain('0.00×');
  });

  it('renders a half-known 52-week range as unknown, not as a range to zero', () => {
    const html = renderToStaticMarkup(
      <CompanyHeader
        overview={{
          available: true,
          provenance: PROV,
          data: {
            profile: { symbol: 'T', exchange: 'NSE', name: 'T', currency: 'INR', provenance: PROV },
            statistics: { symbol: 'T', currency: 'INR', fiftyTwoWeekHigh: 3200, provenance: PROV },
          },
        }}
      />,
    );
    // Half a range is not a range.
    expect(html).not.toContain('3,200 – ');
    expect(html).toContain('not reported');
  });
});

// ──────────────────────────── unavailable sections ───────────────────────────

describe('unavailable sections state the reason', () => {
  it('renders the server reason verbatim', () => {
    const reason = 'the configured data provider (twelvedata) publishes no shareholding register';
    const html = renderToStaticMarkup(<DataUnavailable title="Ownership data unavailable" reason={reason} />);
    expect(html).toContain(reason);
  });

  it('shows an unavailable company header rather than an empty one', () => {
    const html = renderToStaticMarkup(
      <CompanyHeader overview={{ available: false, reason: 'TWELVEDATA_API_KEY is not configured' }} />,
    );
    expect(html).toContain('Company information unavailable');
    expect(html).toContain('TWELVEDATA_API_KEY is not configured');
  });

  it('shows the brief-mandated message when history is unavailable', () => {
    const html = renderToStaticMarkup(
      <HistoryChart
        section={{ available: false, reason: 'historical financial data is unavailable for this company' }}
      />,
    );
    expect(html).toContain('Historical financial data unavailable');
  });

  it('shows ownership and segments as unavailable with the provider named', () => {
    const ownership = renderToStaticMarkup(
      <OwnershipPanel section={{ available: false, reason: 'provider publishes no register' }} />,
    );
    const segments = renderToStaticMarkup(
      <SegmentsPanel section={{ available: false, reason: 'provider publishes no segments' }} />,
    );
    expect(ownership).toContain('Ownership data unavailable');
    expect(segments).toContain('Segment data unavailable');
    // No invented percentages anywhere.
    expect(ownership).not.toMatch(/50\.13|24\.71|15\.36/);
  });

  it('renders "not reported" as words, never as a bare dash', () => {
    const html = renderToStaticMarkup(<NotReported />);
    expect(html).toContain('not reported');
    expect(html).not.toBe('<span>—</span>');
  });
});

// ────────────────────────────────── ratios ───────────────────────────────────

describe('ratios show their working and their gaps', () => {
  const base: ResearchSection<Parameters<typeof RatiosSection>[0]['section'] extends { data: infer D } ? D : never> = {
    available: true,
    provenance: PROV,
    data: {
      ratios: [
        {
          key: 'net_margin',
          label: 'Net margin',
          group: 'profitability',
          value: 12,
          unit: 'percent',
          formula: 'Net income ÷ Revenue',
          inputs: [
            { label: 'netIncome', value: 120 },
            { label: 'revenue', value: 1000 },
          ],
          periodEnd: '2026-03-31',
        },
      ],
      skipped: [
        { key: 'pe', label: 'P/E', group: 'valuation', reason: 'not reported: price, eps' },
      ],
      basisPeriodEnd: '2026-03-31',
      periodType: 'annual',
      currency: 'INR',
      marketInputs: null,
    },
  } as never;

  it('renders the formula beside the computed value', () => {
    const html = renderToStaticMarkup(<RatiosSection section={base as never} />);
    expect(html).toContain('12.00%');
    expect(html).toContain('Net income ÷ Revenue');
  });

  it('renders a skipped ratio with its reason instead of hiding it or zeroing it', () => {
    const html = renderToStaticMarkup(<RatiosSection section={base as never} />);
    expect(html).toContain('P/E');
    expect(html).toContain('not reported: price, eps');
    expect(html).not.toContain('0.00×');
  });
});

// ────────────────────────── balance-sheet reconciliation ─────────────────────

describe('reconciliation banner', () => {
  it('reports a discrepancy with the amount rather than hiding it', () => {
    const html = renderToStaticMarkup(
      <ReconciliationBanner
        check={{
          periodEnd: '2026-03-31',
          balanced: false,
          totalAssets: 1000,
          totalLiabilities: 600,
          totalEquity: 350,
          difference: 50,
          differenceBps: 500,
          currency: 'INR',
        }}
      />,
    );
    expect(html).toContain('does not reconcile');
    expect(html).toContain('50');
    expect(html).toContain('500.0bp');
    expect(html).toContain('does not adjust reported figures');
  });

  it('confirms a balanced sheet', () => {
    const html = renderToStaticMarkup(
      <ReconciliationBanner
        check={{
          periodEnd: '2026-03-31',
          balanced: true,
          totalAssets: 1000,
          totalLiabilities: 600,
          totalEquity: 400,
          difference: 0,
          differenceBps: 0,
          currency: 'INR',
        }}
      />,
    );
    expect(html).toContain('reconciles');
  });

  it('says the check could not be performed when a side is missing', () => {
    const html = renderToStaticMarkup(
      <ReconciliationBanner
        check={{
          periodEnd: '2026-03-31',
          balanced: false,
          totalAssets: 1000,
          totalLiabilities: null,
          totalEquity: null,
          difference: null,
          differenceBps: null,
          currency: 'INR',
          reason: 'not reported: total liabilities',
        }}
      />,
    );
    expect(html).toContain('could not be performed');
    expect(html).toContain('total liabilities');
    // The bug this pins: `difference ?? 0` would have claimed a zero discrepancy.
    expect(html).not.toContain('does not reconcile');
  });
});

// ─────────────────────────────── display scale ───────────────────────────────

describe('display scale never turns a real value into nothing', () => {
  it('scales a large INR statement to crore by default', () => {
    const html = renderToStaticMarkup(
      <StatementTable
        type="income"
        statement={statement([period({ revenue: fact('revenue', 9_740_000_000_000) })])}
      />,
    );
    // 9.74e12 / 1e7 = 9,74,000 crore.
    expect(html).toContain('9,74,000.00');
    expect(html).toContain('INR crore');
    // Not the raw fifteen-digit figure, which is unreadable in a table cell.
    expect(html).not.toContain('9,74,00,00,00,000');
  });

  it('does NOT scale a small statement into a row of zeros', () => {
    const html = renderToStaticMarkup(
      <StatementTable type="income" statement={statement([period({ revenue: fact('revenue', 1000) })])} />,
    );
    // The bug this pins: a blanket crore default renders ₹1,000 as "0.00" — a
    // real number displayed as nothing, which is the same defect as a
    // fabricated one arriving by a different route.
    expect(html).toContain('1,000');
    expect(html).not.toMatch(/>\(?0\.00\)?</);
  });

  it('leaves per-share figures unscaled even when the statement is scaled', () => {
    const html = renderToStaticMarkup(
      <StatementTable
        type="income"
        statement={statement([
          period({
            revenue: fact('revenue', 9_740_000_000_000),
            eps_basic: fact('eps_basic', 18.28),
          }),
        ])}
      />,
    );
    // EPS ÷ 1 crore would be 0.0000018.
    expect(html).toContain('18.28');
    expect(html).toContain('per-share figures and share counts are unscaled');
  });
});

// ──────────────────────────────── history chart ──────────────────────────────

describe('history chart', () => {
  it('plots every reported point and labels it', () => {
    const html = renderToStaticMarkup(
      <HistoryChart
        section={{
          available: true,
          provenance: PROV,
          data: {
            periodType: 'annual',
            series: [
              {
                metric: 'revenue',
                label: 'Revenue',
                unit: 'currency',
                currency: 'INR',
                points: [
                  { periodEnd: '2025-03-31', fiscalYear: 2025, value: 900 },
                  { periodEnd: '2026-03-31', fiscalYear: 2026, value: 1000 },
                ],
              },
            ],
          },
        }}
      />,
    );
    expect((html.match(/<rect/g) ?? []).length).toBe(2);
    expect(html).toContain('2026');
    expect(html).toContain('2025');
  });
});
