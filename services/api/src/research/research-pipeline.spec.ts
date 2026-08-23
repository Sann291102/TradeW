import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  BALANCE_METRICS,
  CASH_FLOW_METRICS,
  INCOME_METRICS,
  FundamentalsUnavailableError,
  TwelveDataFundamentalsProvider,
  clearFundamentalsMemo,
  computeRatios,
  reconcileBalanceSheet,
  resolveFinancialDataProvider,
  type StatementPeriod,
} from '@tradew/market-data';
import { FIXTURE_SYMBOL, startFixtureServer } from './__fixtures__/twelvedata-fixture';
import { parseSections } from './research-analysis.service';

/**
 * The research pipeline, from the vendor's wire format to the numbers a user
 * reads.
 *
 * Every assertion here is about ONE property: a number on the research page is
 * either something the provider actually returned or something derived from it
 * by a formula this file pins — and never anything else. The suite is arranged
 * around the ways that property has historically been broken:
 *
 *   · a vendor's `null`/`""`/`"-"` coerced to 0 by `Number()`
 *   · an empty vendor response rendering as a company with no revenue
 *   · a ratio computed against a missing operand and shown as 0.00
 *   · a balance sheet "fixed" so it always reconciles
 *   · a derived figure presented as reported
 *   · the model inventing a section or a score
 */

let server: Server;
let baseUrl: string;
const savedEnv = { url: process.env.TWELVEDATA_API_URL, key: process.env.TWELVEDATA_API_KEY };

beforeAll(async () => {
  const started = await startFixtureServer();
  server = started.server;
  baseUrl = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.TWELVEDATA_API_URL = savedEnv.url;
  process.env.TWELVEDATA_API_KEY = savedEnv.key;
});

afterEach(() => {
  clearFundamentalsMemo();
});

function useFixture() {
  process.env.TWELVEDATA_API_URL = baseUrl;
  process.env.TWELVEDATA_API_KEY = 'fixture-key';
  clearFundamentalsMemo();
  return new TwelveDataFundamentalsProvider();
}

// ─────────────────────────── provider: availability ──────────────────────────

describe('provider availability', () => {
  it('throws a typed, user-readable error when no API key is configured', async () => {
    process.env.TWELVEDATA_API_URL = baseUrl;
    delete process.env.TWELVEDATA_API_KEY;
    clearFundamentalsMemo();
    const provider = new TwelveDataFundamentalsProvider();

    await expect(provider.getProfile(FIXTURE_SYMBOL)).rejects.toBeInstanceOf(FundamentalsUnavailableError);
    await expect(provider.getProfile(FIXTURE_SYMBOL)).rejects.toMatchObject({
      detail: 'TWELVEDATA_API_KEY is not configured',
    });
  });

  it('treats an unknown symbol as unavailable, not as a company with no financials', async () => {
    const provider = useFixture();
    // The fixture answers 200 with `status: "error"` — the vendor's real
    // behaviour, and the exact shape that becomes a fabricated zero if the
    // client only checks the HTTP status line.
    await expect(provider.getStatement('NOSUCHCO', 'income', 'annual')).rejects.toBeInstanceOf(
      FundamentalsUnavailableError,
    );
  });

  it('never leaks the API key into an error a user could see', async () => {
    process.env.TWELVEDATA_API_URL = 'http://127.0.0.1:1';
    process.env.TWELVEDATA_API_KEY = 'super-secret-key-value';
    clearFundamentalsMemo();
    const provider = new TwelveDataFundamentalsProvider();

    const err = await provider.getProfile(FIXTURE_SYMBOL).catch((e) => e);
    expect(err).toBeInstanceOf(FundamentalsUnavailableError);
    expect(JSON.stringify(err.detail)).not.toContain('super-secret-key-value');
  });

  it('reports ownership and segments as unavailable rather than returning empty ones', async () => {
    const provider = useFixture();
    await expect(provider.getOwnership(FIXTURE_SYMBOL)).rejects.toMatchObject({
      detail: expect.stringContaining('shareholding register'),
    });
    await expect(provider.getSegments(FIXTURE_SYMBOL)).rejects.toMatchObject({
      detail: expect.stringContaining('segment reporting'),
    });
  });

  it('resolves only providers this build knows', () => {
    expect(resolveFinancialDataProvider('twelvedata').name).toBe('twelvedata');
    expect(() => resolveFinancialDataProvider('sample-data')).toThrow(FundamentalsUnavailableError);
  });
});

// ────────────────────────── provider: normalization ──────────────────────────

describe('statement normalization', () => {
  it('normalizes an income statement into canonical metrics, newest first', async () => {
    const provider = useFixture();
    const statement = await provider.getStatement(FIXTURE_SYMBOL, 'income', 'annual');

    expect(statement.periods).toHaveLength(5);
    expect(statement.periods.map((p) => p.fiscalYear)).toEqual([2026, 2025, 2024, 2023, 2022]);

    const latest = statement.periods[0]!;
    expect(latest.currency).toBe('INR');
    expect(latest.facts[INCOME_METRICS.revenue]?.value).toBeCloseTo(9_740_000_000_000, 0);
    expect(latest.facts[INCOME_METRICS.netIncome]?.value).toBeCloseTo(9_740_000_000_000 * 0.12, 0);
    expect(latest.facts[INCOME_METRICS.eps]?.basis).toBe('reported');
  });

  it('marks a summed operating-expense line as derived, not reported', async () => {
    const provider = useFixture();
    const statement = await provider.getStatement(FIXTURE_SYMBOL, 'income', 'annual');
    const opex = statement.periods[0]!.facts[INCOME_METRICS.operatingExpenses];

    // The fixture omits `total_operating_expense`, so the value can only have
    // come from summing SG&A and R&D. Presenting that as reported would send a
    // reader to an annual report looking for a line that is not in it.
    expect(opex?.basis).toBe('derived');
    expect(opex?.value).toBeCloseTo(9_740_000_000_000 * 0.23, 0);
  });

  it('derives free cash flow as OCF minus |CapEx| and labels it derived', async () => {
    const provider = useFixture();
    const statement = await provider.getStatement(FIXTURE_SYMBOL, 'cash_flow', 'annual');
    const latest = statement.periods[0]!;

    const ocf = latest.facts[CASH_FLOW_METRICS.operatingCashFlow]!.value;
    const capex = latest.facts[CASH_FLOW_METRICS.capitalExpenditure]!.value;
    const fcf = latest.facts[CASH_FLOW_METRICS.freeCashFlow]!;

    expect(capex).toBeLessThan(0); // filed as an outflow
    expect(fcf.basis).toBe('derived');
    expect(fcf.value).toBeCloseTo(ocf - Math.abs(capex), 0);
    // The bug this pins: `ocf + capex` with a negative capex would put FCF
    // ABOVE operating cash flow, which is arithmetically tidy and financially
    // impossible.
    expect(fcf.value).toBeLessThan(ocf);
  });

  it('leaves a line the vendor did not publish ABSENT rather than zero', async () => {
    const provider = useFixture();
    const balance = await provider.getStatement(FIXTURE_SYMBOL, 'balance', 'annual');
    const latest = balance.periods[0]!;

    // The fixture omits treasury stock and OCI.
    expect(latest.facts[BALANCE_METRICS.treasuryStock]).toBeUndefined();
    expect(latest.facts[BALANCE_METRICS.otherComprehensiveIncome]).toBeUndefined();
    // Not `toBe(0)` — the whole point is that there is no key at all, so a
    // consumer cannot read a number that was never filed.
    expect(Object.keys(latest.facts)).not.toContain(BALANCE_METRICS.treasuryStock);
  });

  it('attaches provenance to every single fact', async () => {
    const provider = useFixture();
    const statement = await provider.getStatement(FIXTURE_SYMBOL, 'income', 'annual');

    for (const period of statement.periods) {
      for (const fact of Object.values(period.facts)) {
        expect(fact.provenance.source).toBe('twelvedata');
        expect(fact.provenance.sourceTimestamp).toBe(period.periodEnd);
        expect(Date.parse(fact.provenance.fetchedAt)).not.toBeNaN();
      }
    }
  });

  it('reads the company profile and statistics, omitting fields the vendor left out', async () => {
    const provider = useFixture();
    const [profile, stats] = await Promise.all([
      provider.getProfile(FIXTURE_SYMBOL),
      provider.getStatistics(FIXTURE_SYMBOL),
    ]);

    expect(profile.name).toBe('Testco Industries Limited');
    expect(profile.sector).toBe('Energy');
    expect(stats.marketCap).toBe(19_310_000_000_000);
    expect(stats.vendorTrailingPe).toBe(24.9);
    // The fixture publishes no forward P/E or PEG. This system has no earnings
    // estimates, so both must stay absent rather than be back-solved.
    expect(stats.vendorForwardPe).toBeUndefined();
    expect(stats.vendorPegRatio).toBeUndefined();
    expect(stats.dividendYield).toBeCloseTo(0.37, 5);
  });

  it('finds the company by name as well as by symbol', async () => {
    const provider = useFixture();
    const hits = await provider.searchSymbols('testco', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ symbol: FIXTURE_SYMBOL, exchange: 'NSE' });
  });
});

// ──────────────────────────────── ratio engine ───────────────────────────────

/** Minimal period builder — every fact reported, one currency. */
function period(facts: Record<string, number>, periodEnd = '2026-03-31'): StatementPeriod {
  return {
    fiscalYear: Number(periodEnd.slice(0, 4)),
    periodEnd,
    periodType: 'annual',
    currency: 'INR',
    facts: Object.fromEntries(
      Object.entries(facts).map(([metric, value]) => [
        metric,
        {
          metric,
          value,
          currency: 'INR',
          basis: 'reported' as const,
          provenance: { source: 'test', sourceTimestamp: periodEnd, fetchedAt: new Date().toISOString() },
        },
      ]),
    ),
  };
}

describe('ratio computation', () => {
  it('computes margins and returns from reported statement values', () => {
    const { ratios } = computeRatios({
      income: period({
        [INCOME_METRICS.revenue]: 1000,
        [INCOME_METRICS.grossProfit]: 400,
        [INCOME_METRICS.operatingIncome]: 200,
        [INCOME_METRICS.netIncome]: 120,
        [INCOME_METRICS.eps]: 12,
        [INCOME_METRICS.ebit]: 200,
        [INCOME_METRICS.pretaxIncome]: 160,
        [INCOME_METRICS.incomeTax]: 40,
      }),
      balance: period({
        [BALANCE_METRICS.totalAssets]: 2000,
        [BALANCE_METRICS.totalEquity]: 1000,
        [BALANCE_METRICS.totalCurrentAssets]: 600,
        [BALANCE_METRICS.totalCurrentLiabilities]: 300,
        [BALANCE_METRICS.inventory]: 100,
        [BALANCE_METRICS.shortTermDebt]: 100,
        [BALANCE_METRICS.longTermDebt]: 300,
        [BALANCE_METRICS.cashAndEquivalents]: 200,
      }),
      market: { price: 240, marketCap: 2400, enterpriseValue: 2600 },
    });

    const by = Object.fromEntries(ratios.map((r) => [r.key, r.value]));
    expect(by.gross_margin).toBeCloseTo(40);
    expect(by.operating_margin).toBeCloseTo(20);
    expect(by.net_margin).toBeCloseTo(12);
    expect(by.roe).toBeCloseTo(12);
    expect(by.roa).toBeCloseTo(6);
    expect(by.pe).toBeCloseTo(20);
    expect(by.pb).toBeCloseTo(2.4);
    expect(by.current_ratio).toBeCloseTo(2);
    expect(by.quick_ratio).toBeCloseTo(5 / 3);
    expect(by.debt_equity).toBeCloseTo(0.4);
    // ROIC = EBIT × (1 − 40/160) ÷ (400 debt + 1000 equity) = 150/1400
    expect(by.roic).toBeCloseTo((200 * 0.75) / 1400 * 100);
  });

  it('SKIPS a ratio whose operand is missing, with the operand named', () => {
    const { ratios, skipped } = computeRatios({
      income: period({ [INCOME_METRICS.revenue]: 1000 }),
      market: {},
    });

    // The defect this pins: a P/E rendered as 0.00 because price was undefined
    // and `undefined / x` was coerced somewhere along the way.
    expect(ratios.find((r) => r.key === 'pe')).toBeUndefined();
    const pe = skipped.find((s) => s.key === 'pe');
    expect(pe?.reason).toContain('price');
    expect(pe?.reason).toContain('eps');
  });

  it('SKIPS rather than emits a meaningless multiple on negative inputs', () => {
    const { ratios, skipped } = computeRatios({
      income: period({ [INCOME_METRICS.revenue]: 1000, [INCOME_METRICS.eps]: -4, [INCOME_METRICS.ebitda]: -50 }),
      balance: period({ [BALANCE_METRICS.totalEquity]: -200, [BALANCE_METRICS.totalAssets]: 500 }),
      market: { price: 100, marketCap: 1000, enterpriseValue: 1200 },
    });

    for (const key of ['pe', 'pb', 'ev_ebitda']) {
      expect(ratios.find((r) => r.key === key)).toBeUndefined();
      expect(skipped.find((s) => s.key === key)).toBeDefined();
    }
  });

  it('never divides by zero', () => {
    const { ratios, skipped } = computeRatios({
      income: period({ [INCOME_METRICS.revenue]: 0, [INCOME_METRICS.grossProfit]: 0 }),
      balance: period({ [BALANCE_METRICS.totalCurrentAssets]: 10, [BALANCE_METRICS.totalCurrentLiabilities]: 0 }),
      market: { marketCap: 100 },
    });
    expect(ratios.every((r) => Number.isFinite(r.value))).toBe(true);
    expect(skipped.find((s) => s.key === 'gross_margin')?.reason).toContain('zero');
    expect(skipped.find((s) => s.key === 'current_ratio')?.reason).toContain('zero');
  });

  it('carries the formula and the exact operands on every computed ratio', () => {
    const { ratios } = computeRatios({
      income: period({ [INCOME_METRICS.revenue]: 1000, [INCOME_METRICS.netIncome]: 150 }),
    });
    const netMargin = ratios.find((r) => r.key === 'net_margin')!;

    expect(netMargin.formula).toBe('Net income ÷ Revenue');
    expect(netMargin.inputs).toEqual(
      expect.arrayContaining([
        { label: 'netIncome', value: 150 },
        { label: 'revenue', value: 1000 },
      ]),
    );
    expect(netMargin.periodEnd).toBe('2026-03-31');
  });

  it('computes growth only against a prior period of the same cadence', () => {
    const withPrior = computeRatios({
      income: period({ [INCOME_METRICS.revenue]: 1100 }, '2026-03-31'),
      incomePrevious: period({ [INCOME_METRICS.revenue]: 1000 }, '2025-03-31'),
    });
    expect(withPrior.ratios.find((r) => r.key === 'revenue_growth')?.value).toBeCloseTo(10);

    const withoutPrior = computeRatios({ income: period({ [INCOME_METRICS.revenue]: 1100 }) });
    expect(withoutPrior.ratios.find((r) => r.key === 'revenue_growth')).toBeUndefined();
    expect(withoutPrior.skipped.find((s) => s.key === 'revenue_growth')?.reason).toContain('revenuePrev');
  });

  it('emits no forward-looking ratio, because this system holds no estimates', () => {
    const { ratios, skipped } = computeRatios({
      income: period({ [INCOME_METRICS.revenue]: 1000, [INCOME_METRICS.eps]: 10 }),
      market: { price: 200, marketCap: 2000 },
    });
    const keys = [...ratios.map((r) => r.key), ...skipped.map((s) => s.key)];
    expect(keys).not.toContain('forward_pe');
    expect(keys).not.toContain('peg');
  });
});

// ─────────────────────────── balance-sheet reconciliation ────────────────────

describe('balance-sheet reconciliation', () => {
  it('reports balanced when the identity holds', () => {
    const check = reconcileBalanceSheet(
      period({
        [BALANCE_METRICS.totalAssets]: 1000,
        [BALANCE_METRICS.totalLiabilities]: 600,
        [BALANCE_METRICS.totalEquity]: 400,
      }),
    )!;
    expect(check.balanced).toBe(true);
    expect(check.difference).toBe(0);
  });

  it('REPORTS a discrepancy instead of silently adjusting a value', () => {
    const check = reconcileBalanceSheet(
      period({
        [BALANCE_METRICS.totalAssets]: 1000,
        [BALANCE_METRICS.totalLiabilities]: 600,
        [BALANCE_METRICS.totalEquity]: 350,
      }),
    )!;

    expect(check.balanced).toBe(false);
    expect(check.difference).toBe(50);
    expect(check.differenceBps).toBeCloseTo(500);
    // The reported numbers must come back untouched — the temptation this
    // guards against is "fixing" equity to 400 so the page always balances.
    expect(check.totalEquity).toBe(350);
    expect(check.totalLiabilities).toBe(600);
    expect(check.totalAssets).toBe(1000);
  });

  it('tolerates vendor rounding without tolerating a missing line item', () => {
    const rounding = reconcileBalanceSheet(
      period({
        [BALANCE_METRICS.totalAssets]: 1_000_000,
        [BALANCE_METRICS.totalLiabilities]: 600_000,
        [BALANCE_METRICS.totalEquity]: 399_990, // 10bp
      }),
    )!;
    expect(rounding.balanced).toBe(true);

    const missingLine = reconcileBalanceSheet(
      period({
        [BALANCE_METRICS.totalAssets]: 1_000_000,
        [BALANCE_METRICS.totalLiabilities]: 600_000,
        [BALANCE_METRICS.totalEquity]: 380_000, // 200bp
      }),
    )!;
    expect(missingLine.balanced).toBe(false);
  });

  it('says the check could not be performed when a side was not reported', () => {
    const check = reconcileBalanceSheet(period({ [BALANCE_METRICS.totalAssets]: 1000 }))!;
    expect(check.balanced).toBe(false);
    expect(check.reason).toContain('total liabilities');
    expect(check.difference).toBeNull();
  });

  it('reconciles the fixture end to end, through the real provider', async () => {
    const provider = useFixture();
    const balance = await provider.getStatement(FIXTURE_SYMBOL, 'balance', 'annual');
    const check = reconcileBalanceSheet(balance.periods[0])!;
    expect(check.balanced).toBe(true);
  });
});

// ──────────────────────────── AI response parsing ────────────────────────────

describe('AI analysis parsing', () => {
  it('accepts the requested headings', () => {
    const sections = parseSections(
      JSON.stringify({ sections: [{ heading: 'Growth', body: 'Revenue rose 8.1% in FY2026.' }] }),
    );
    expect(sections).toEqual([{ heading: 'Growth', body: 'Revenue rose 8.1% in FY2026.' }]);
  });

  it('unwraps a fenced block rather than failing on formatting noise', () => {
    const sections = parseSections('```json\n{"sections":[{"heading":"Risks","body":"Leverage is elevated."}]}\n```');
    expect(sections).toHaveLength(1);
  });

  it('DROPS a heading the model invented', () => {
    const sections = parseSections(
      JSON.stringify({
        sections: [
          { heading: 'Growth', body: 'ok' },
          { heading: 'Recommendation', body: 'Buy.' },
          { heading: 'Confidence', body: '87%' },
        ],
      }),
    );
    expect(sections.map((s) => s.heading)).toEqual(['Growth']);
  });

  it('returns nothing at all for an unparseable answer', () => {
    expect(parseSections('I am unable to help with that.')).toEqual([]);
    expect(parseSections('{"sections": [')).toEqual([]);
    expect(parseSections('')).toEqual([]);
  });

  it('drops a section with an empty body rather than rendering a blank card', () => {
    expect(parseSections(JSON.stringify({ sections: [{ heading: 'Risks', body: '   ' }] }))).toEqual([]);
  });
});
