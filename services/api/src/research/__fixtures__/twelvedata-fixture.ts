/**
 * A Twelve Data wire-format fixture, and a tiny server that serves it.
 *
 * ── WHY THIS EXISTS AND WHERE IT MAY BE USED ───────────────────────────────
 *
 * This is a TEST DOUBLE FOR THE VENDOR, not a data source for the product. It
 * speaks the vendor's HTTP shape so that the real `TwelveDataFundamentalsProvider`
 * — the real fetch, the real normalizer, the real error handling — can be
 * exercised end to end without reaching the internet.
 *
 * It is reachable ONLY by pointing `TWELVEDATA_API_URL` at it, an override that
 * already existed for the quotes client. There is no code path in the product
 * that selects this file, no environment flag that enables "sample data", and no
 * fallback anywhere that could reach it. That is deliberate: the failure this
 * whole subsystem exists to prevent is synthetic financials reaching a user, so
 * the double lives behind an explicit host redirect that an operator would have
 * to set on purpose.
 *
 * The numbers below are ARBITRARY and internally consistent. They are shaped to
 * exercise the interesting paths — a balance sheet that reconciles, absent lines
 * that must not become zeros, a vendor-omitted free cash flow that must be
 * derived — and they describe no real company.
 */

import { createServer, type Server } from 'node:http';

const CURRENCY = 'INR';

/** Deliberately NOT a real issuer: a fictional name, so a screenshot of the
 *  fixture can never be mistaken for research about a listed company. */
export const FIXTURE_SYMBOL = 'TESTCO';

function annualIncome(year: number, revenue: number) {
  const grossProfit = revenue * 0.42;
  const operatingIncome = revenue * 0.19;
  const netIncome = revenue * 0.12;
  return {
    fiscal_date: `${year}-03-31`,
    fiscal_year: year,
    sales: revenue,
    cost_of_goods: revenue - grossProfit,
    gross_profit: grossProfit,
    operating_expense: {
      selling_general_and_administrative: revenue * 0.14,
      research_and_development: revenue * 0.09,
    },
    operating_income: operatingIncome,
    ebitda: revenue * 0.24,
    ebit: operatingIncome,
    non_operating_interest: { interest_expense: revenue * 0.015 },
    pretax_income: revenue * 0.165,
    income_tax: revenue * 0.045,
    net_income: netIncome,
    eps_basic: netIncome / 6_400_000_000,
    eps_diluted: (netIncome / 6_400_000_000) * 0.99,
    basic_shares_outstanding: 6_400_000_000,
    diluted_shares_outstanding: 6_460_000_000,
    // `total_operating_expense` is deliberately ABSENT so the normalizer's
    // derived-sum path is exercised and marked `derived`.
  };
}

function annualBalance(year: number, assets: number) {
  const liabilities = assets * 0.46;
  // Equity is set so the identity holds EXACTLY — the reconciliation check must
  // report `balanced` for this fixture, and a fixture that never balances could
  // not distinguish a working check from one that always says "not balanced".
  const equity = assets - liabilities;
  return {
    fiscal_date: `${year}-03-31`,
    fiscal_year: year,
    assets: {
      current_assets: {
        cash: assets * 0.08,
        cash_equivalents: assets * 0.04,
        accounts_receivable: assets * 0.05,
        inventory: assets * 0.06,
        other_current_assets: assets * 0.03,
        total_current_assets: assets * 0.26,
      },
      non_current_assets: {
        properties: assets * 0.51,
        goodwill: assets * 0.04,
        intangible_assets: assets * 0.05,
        long_term_investments: assets * 0.1,
        other_non_current_assets: assets * 0.04,
      },
      total_assets: assets,
    },
    liabilities: {
      current_liabilities: {
        accounts_payable: assets * 0.11,
        short_term_debt: assets * 0.06,
        other_current_liabilities: assets * 0.04,
        total_current_liabilities: assets * 0.21,
      },
      non_current_liabilities: {
        long_term_debt: assets * 0.19,
        long_term_capital_lease_obligation: assets * 0.03,
        other_non_current_liabilities: assets * 0.03,
      },
      total_liabilities: liabilities,
    },
    shareholders_equity: {
      common_stock: assets * 0.01,
      additional_paid_in_capital: assets * 0.09,
      retained_earnings: assets * 0.43,
      // `treasury_stock` and `accumulated_other_comprehensive_income` are
      // ABSENT on purpose: they must render as "not reported", never as 0.
      total_shareholders_equity: equity,
    },
  };
}

function annualCashFlow(year: number, ocf: number) {
  return {
    fiscal_date: `${year}-03-31`,
    fiscal_year: year,
    operating_activities: {
      net_income: ocf * 0.55,
      depreciation: ocf * 0.3,
      change_in_working_capital: -(ocf * 0.08),
    },
    operating_cash_flow: ocf,
    investing_activities: { capital_expenditures: -(ocf * 0.52) },
    investing_cash_flow: -(ocf * 0.61),
    financing_activities: {
      long_term_debt_issuance: ocf * 0.12,
      dividend_payout: -(ocf * 0.07),
    },
    financing_cash_flow: -(ocf * 0.02),
    net_change_in_cash: ocf * 0.37,
    // `free_cash_flow` ABSENT on purpose — the derivation path
    // (OCF − |CapEx|) must run and be labelled `derived`.
  };
}

const YEARS = [2026, 2025, 2024, 2023, 2022];
const REVENUE_BY_YEAR: Record<number, number> = {
  2026: 9_740_000_000_000,
  2025: 9_010_000_000_000,
  2024: 8_320_000_000_000,
  2023: 7_760_000_000_000,
  2022: 6_940_000_000_000,
};

export const FIXTURE = {
  profile: {
    symbol: FIXTURE_SYMBOL,
    name: 'Testco Industries Limited',
    exchange: 'NSE',
    mic_code: 'XNSE',
    sector: 'Energy',
    industry: 'Oil & Gas Refining',
    employees: 389_000,
    website: 'https://example.invalid',
    description: 'A fictional diversified issuer used to exercise the research pipeline.',
    country: 'India',
    currency: CURRENCY,
    isin: 'INE000A00000',
  },
  statistics: {
    meta: { symbol: FIXTURE_SYMBOL, currency: CURRENCY },
    statistics: {
      valuations_metrics: {
        market_capitalization: 19_310_000_000_000,
        enterprise_value: 22_040_000_000_000,
        trailing_pe: 24.9,
        // `forward_pe` and `peg_ratio` ABSENT — the UI must not show a forward
        // multiple this system cannot source.
      },
      stock_statistics: { shares_outstanding: 6_400_000_000, float_shares: 3_010_000_000 },
      stock_price_summary: { fifty_two_week_high: 3_217.9, fifty_two_week_low: 2_220.3, beta: 0.94 },
      dividends_and_splits: { forward_annual_dividend_yield: 0.0037 },
    },
  },
  income_statement: {
    meta: { symbol: FIXTURE_SYMBOL, currency: CURRENCY, period: 'Annual' },
    income_statement: YEARS.map((y) => annualIncome(y, REVENUE_BY_YEAR[y]!)),
  },
  balance_sheet: {
    meta: { symbol: FIXTURE_SYMBOL, currency: CURRENCY, period: 'Annual' },
    balance_sheet: YEARS.map((y) => annualBalance(y, REVENUE_BY_YEAR[y]! * 1.9)),
  },
  cash_flow: {
    meta: { symbol: FIXTURE_SYMBOL, currency: CURRENCY, period: 'Annual' },
    cash_flow: YEARS.map((y) => annualCashFlow(y, REVENUE_BY_YEAR[y]! * 0.17)),
  },
  symbol_search: {
    data: [
      {
        symbol: FIXTURE_SYMBOL,
        instrument_name: 'Testco Industries Limited',
        exchange: 'NSE',
        mic_code: 'XNSE',
        country: 'India',
        currency: CURRENCY,
        instrument_type: 'Common Stock',
      },
    ],
  },
};

/**
 * Serve the fixture on an ephemeral port.
 *
 * Any symbol other than the fixture's gets the vendor's own not-found shape
 * (200 with `status: 'error'`), so the provider's "errors arrive inside a 200
 * body" handling is exercised rather than assumed.
 */
/**
 * Derive four quarters from each annual row: same lines, quartered magnitudes,
 * explicit `quarter` and quarter-end `fiscal_date`. Flow lines divide by four;
 * balance-sheet stocks are point-in-time and are left as filed.
 */
function quarterlyOf(annual: Record<string, unknown>, key: string): Record<string, unknown> {
  const rows = (annual[key] as Array<Record<string, unknown>>) ?? [];
  const isStock = key === 'balance_sheet';
  const quarterEnds = ['06-30', '09-30', '12-31', '03-31'];
  const out: Array<Record<string, unknown>> = [];

  const scale = (v: unknown): unknown => {
    if (typeof v === 'number') return isStock ? v : v / 4;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scale(x)]));
    }
    return v;
  };

  for (const row of rows.slice(0, 2)) {
    const year = Number(row.fiscal_year);
    for (let q = 4; q >= 1; q--) {
      const scaled = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, scale(v)]));
      out.push({
        ...scaled,
        fiscal_year: year,
        quarter: q,
        fiscal_date: `${q === 4 ? year : year - 1}-${quarterEnds[q - 1]}`,
      });
    }
  }
  return { ...annual, [key]: out };
}

export function startFixtureServer(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
    const path = url.pathname;

    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path === '/symbol_search') {
      const q = symbol.toLowerCase();
      const hit = 'testco'.includes(q) || FIXTURE_SYMBOL.toLowerCase().includes(q);
      return send({ data: hit ? FIXTURE.symbol_search.data : [] });
    }

    if (symbol !== FIXTURE_SYMBOL) {
      return send({ status: 'error', code: 404, message: `symbol "${symbol}" not found` });
    }

    // Quarterly is served as genuinely different rows — same shape, quartered
    // magnitudes and real quarter fields. A fixture that ignored `period` would
    // make the annual/quarterly switch look verified when nothing had changed.
    const quarterly = url.searchParams.get('period') === 'quarterly';

    switch (path) {
      case '/profile':
        return send(FIXTURE.profile);
      case '/statistics':
        return send(FIXTURE.statistics);
      case '/income_statement':
        return send(quarterly ? quarterlyOf(FIXTURE.income_statement, 'income_statement') : FIXTURE.income_statement);
      case '/balance_sheet':
        return send(quarterly ? quarterlyOf(FIXTURE.balance_sheet, 'balance_sheet') : FIXTURE.balance_sheet);
      case '/cash_flow':
        return send(quarterly ? quarterlyOf(FIXTURE.cash_flow, 'cash_flow') : FIXTURE.cash_flow);
      default:
        return send({ status: 'error', code: 404, message: `no such endpoint ${path}` }, 200);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://127.0.0.1:${bound}` });
    });
  });
}
