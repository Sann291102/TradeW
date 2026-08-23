/**
 * Twelve Data — fundamental statements, company profile and statistics.
 *
 * Companion to `twelvedata.client.ts` (quotes/candles) and deliberately a
 * SEPARATE file: quotes are per-second and batched, fundamentals are per-quarter
 * and per-symbol, and the two have nothing in common but the vendor and the key.
 *
 * ── WHY THIS VENDOR ────────────────────────────────────────────────────────
 *
 * It is the vendor this repository already carries a key for (Forex, US stocks),
 * it covers NSE/BSE as well as US listings, and it publishes the exact surface
 * this page needs: /profile, /statistics, /income_statement, /balance_sheet,
 * /cash_flow, /symbol_search. Adding a second vendor would mean a second key, a
 * second quota and a second normalizer for no capability gain today — which is
 * why `FinancialDataProvider` exists, so the second one costs a file and not a
 * refactor.
 *
 * ── FAILURE IS A FIRST-CLASS RESULT ────────────────────────────────────────
 *
 * Every method resolves with real vendor data or throws
 * `FundamentalsUnavailableError`. There is no empty-but-successful return: a
 * vendor that answers 200 with an empty statement array has told us it has no
 * coverage, not that the company earned nothing, and the two must not render the
 * same. The error's `detail` is user-facing and never carries the API key.
 *
 * Fundamentals endpoints are credit-metered. Statements change quarterly, so the
 * durable cache in services/api is what actually protects the quota; the short
 * process-local memo here only collapses the burst a single page load produces
 * (overview + three statements + ratios all want /statistics).
 */

import {
  BALANCE_METRICS,
  CASH_FLOW_METRICS,
  INCOME_METRICS,
  FundamentalsUnavailableError,
  type CompanyProfile,
  type CompanyStatistics,
  type FinancialDataProvider,
  type FinancialFact,
  type FinancialStatement,
  type OwnershipBreakdown,
  type PeriodType,
  type Provenance,
  type SegmentBreakdown,
  type StatementPeriod,
  type StatementType,
  type SymbolSearchHit,
} from './fundamentals.contract';

/**
 * Config is read AT CALL TIME, not captured at module load.
 *
 * A module-level `const TD_API = process.env...` is a snapshot taken whenever
 * this file first happens to be imported — which is before `dotenv` has run in
 * some boot orders, and before a test can redirect the host in all of them. The
 * live-feed server carries the same warning for the same reason. The cost is a
 * property read per request, measured against a network call.
 */
const apiBase = () => process.env.TWELVEDATA_API_URL || 'https://api.twelvedata.com';
const timeoutMs = () => Number(process.env.TWELVEDATA_TIMEOUT_MS ?? 10_000);
/** Collapses the burst one page load produces. The durable cache does the real work. */
const memoTtlMs = () => Number(process.env.TWELVEDATA_FUNDAMENTALS_MEMO_MS ?? 30_000);

const memo = new Map<string, { at: number; value: unknown }>();

/** Exposed for tests, which must not inherit another case's memoised answer. */
export function clearFundamentalsMemo(): void {
  memo.clear();
}

function apiKey(): string {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new FundamentalsUnavailableError('TWELVEDATA_API_KEY is not configured');
  return key;
}

/**
 * Vendor GET with the three failure modes that matter, kept apart:
 * transport/timeout, a non-2xx status line, and Twelve Data's habit of
 * signalling errors inside a 200 body (a quota breach otherwise parses as a
 * successful empty response — the exact shape that becomes a fabricated zero
 * downstream).
 */
async function getJson<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const search = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apikey: apiKey() });
  const url = `${apiBase()}${path}?${search.toString()}`;
  const memoKey = `${path}?${new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString()}`;

  const hit = memo.get(memoKey);
  if (hit && Date.now() - hit.at < memoTtlMs()) return hit.value as T;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new FundamentalsUnavailableError(`Twelve Data returned ${res.status}`);
    const body = (await res.json()) as T & { status?: string; message?: string; code?: number };
    if (body && typeof body === 'object' && 'status' in body && body.status === 'error') {
      throw new FundamentalsUnavailableError(body.message ?? `vendor error ${body.code ?? ''}`.trim());
    }
    memo.set(memoKey, { at: Date.now(), value: body });
    return body;
  } catch (err) {
    if (err instanceof FundamentalsUnavailableError) throw err;
    // Never let a URL carrying `apikey` reach a message a user might see.
    const reason = err instanceof Error ? err.message : String(err);
    throw new FundamentalsUnavailableError(reason.replace(/apikey=[^&\s]+/gi, 'apikey=***'));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vendor number -> number | undefined.
 *
 * The single most important function in this file. Twelve Data emits absent
 * values as `null`, `""`, `"-"` and occasionally the string `"None"`; every one
 * of them must become `undefined` (an absent key downstream) and NOT `0`.
 * `Number(null)` is 0 and `Number("")` is 0, so a naive cast here is exactly how
 * a page ends up reporting that a company had zero revenue.
 */
function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed === '' || trimmed === '-' || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'null') {
    return undefined;
  }
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' || t === '-' ? undefined : t;
}

function provenance(sourceTimestamp: string | null): Provenance {
  return { source: 'twelvedata', sourceTimestamp, fetchedAt: new Date().toISOString() };
}

/** Build a fact only when the value is genuinely present. */
function put(
  facts: Record<string, FinancialFact>,
  metric: string,
  value: number | undefined,
  currency: string,
  prov: Provenance,
  basis: 'reported' | 'derived' = 'reported',
): void {
  if (value === undefined) return;
  facts[metric] = { metric, value, currency, basis, provenance: prov };
}

// ───────────────────────────── vendor wire types ─────────────────────────────
// Modelled loosely (`unknown` leaves) on purpose: the normalizers below read
// every leaf through `num`/`str`, so a vendor shape change degrades to a missing
// metric rather than to a runtime crash or a coerced zero.

interface TdMeta {
  symbol?: string;
  name?: string;
  currency?: string;
  exchange?: string;
  period?: string;
}
type TdRow = Record<string, unknown>;

function rowsOf(body: Record<string, unknown>, key: string): TdRow[] {
  const raw = body[key];
  return Array.isArray(raw) ? (raw as TdRow[]) : [];
}

function obj(row: TdRow | undefined, key: string): TdRow {
  const v = row?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as TdRow) : {};
}

/** Fiscal year/quarter/period-end from a vendor statement row. */
function periodOf(row: TdRow, periodType: PeriodType): { fiscalYear: number; fiscalQuarter?: number; periodEnd: string } | null {
  const periodEnd = str(row.fiscal_date) ?? str(row.fiscal_date_ending) ?? str(row.date);
  if (!periodEnd) return null;
  const year = num(row.fiscal_year) ?? Number(periodEnd.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  if (periodType === 'annual') return { fiscalYear: year, periodEnd };
  const q = num(row.quarter) ?? Math.floor((Number(periodEnd.slice(5, 7)) - 1) / 3) + 1;
  return { fiscalYear: year, fiscalQuarter: Number.isFinite(q) ? q : undefined, periodEnd };
}

// ─────────────────────────────── the provider ────────────────────────────────

export class TwelveDataFundamentalsProvider implements FinancialDataProvider {
  readonly name = 'twelvedata';

  async searchSymbols(query: string, limit: number): Promise<SymbolSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const body = await getJson<{ data?: TdRow[] }>('/symbol_search', { symbol: q, outputsize: Math.min(limit, 30) });
    const rows = Array.isArray(body.data) ? body.data : [];
    return rows
      .map((r): SymbolSearchHit | null => {
        const symbol = str(r.symbol);
        const name = str(r.instrument_name);
        const exchange = str(r.exchange);
        if (!symbol || !name || !exchange) return null;
        return {
          symbol,
          name,
          exchange,
          micCode: str(r.mic_code),
          country: str(r.country),
          currency: str(r.currency),
          instrumentType: str(r.instrument_type),
        };
      })
      .filter((h): h is SymbolSearchHit => h !== null)
      .slice(0, limit);
  }

  async getProfile(symbol: string): Promise<CompanyProfile> {
    const body = await getJson<TdRow>('/profile', { symbol });
    const name = str(body.name);
    const exchange = str(body.exchange);
    if (!name || !exchange) {
      throw new FundamentalsUnavailableError(`no company profile published for "${symbol}"`);
    }
    return {
      symbol: str(body.symbol) ?? symbol,
      exchange,
      name,
      currency: str(body.currency) ?? 'USD',
      sector: str(body.sector),
      industry: str(body.industry),
      country: str(body.country),
      isin: str(body.isin),
      website: str(body.website),
      employees: num(body.employees),
      description: str(body.description),
      // /profile carries no vendor timestamp — say so rather than backfilling
      // the fetch time and implying the vendor stamped it.
      provenance: provenance(null),
    };
  }

  async getStatistics(symbol: string): Promise<CompanyStatistics> {
    const body = await getJson<{ meta?: TdMeta; statistics?: TdRow }>('/statistics', { symbol });
    const stats = body.statistics;
    if (!stats) throw new FundamentalsUnavailableError(`no statistics published for "${symbol}"`);

    const valuation = obj(stats, 'valuations_metrics');
    const priceSummary = obj(stats, 'stock_price_summary');
    const dividends = obj(stats, 'dividends_and_splits');
    const shareStats = obj(stats, 'stock_statistics');

    return {
      symbol,
      currency: body.meta?.currency ?? 'USD',
      marketCap: num(valuation.market_capitalization),
      enterpriseValue: num(valuation.enterprise_value),
      sharesOutstanding: num(shareStats.shares_outstanding),
      floatShares: num(shareStats.float_shares),
      fiftyTwoWeekHigh: num(priceSummary.fifty_two_week_high),
      fiftyTwoWeekLow: num(priceSummary.fifty_two_week_low),
      beta: num(priceSummary.beta),
      // Vendor publishes a fraction; the UI formats percentages.
      dividendYield: (() => {
        const y = num(dividends.forward_annual_dividend_yield);
        return y === undefined ? undefined : y * 100;
      })(),
      vendorTrailingPe: num(valuation.trailing_pe),
      vendorForwardPe: num(valuation.forward_pe),
      vendorPegRatio: num(valuation.peg_ratio),
      provenance: provenance(null),
    };
  }

  async getStatement(symbol: string, type: StatementType, periodType: PeriodType): Promise<FinancialStatement> {
    if (type === 'income') return this.incomeStatement(symbol, periodType);
    if (type === 'balance') return this.balanceSheet(symbol, periodType);
    return this.cashFlow(symbol, periodType);
  }

  private async incomeStatement(symbol: string, periodType: PeriodType): Promise<FinancialStatement> {
    const body = await getJson<{ meta?: TdMeta; income_statement?: TdRow[] }>('/income_statement', {
      symbol,
      period: periodType,
    });
    const rows = rowsOf(body as Record<string, unknown>, 'income_statement');
    if (rows.length === 0) {
      throw new FundamentalsUnavailableError(`no ${periodType} income statement published for "${symbol}"`);
    }
    const currency = body.meta?.currency ?? 'USD';

    const periods = rows
      .map((row): StatementPeriod | null => {
        const p = periodOf(row, periodType);
        if (!p) return null;
        const prov = provenance(p.periodEnd);
        const facts: Record<string, FinancialFact> = {};
        const opex = obj(row, 'operating_expense');
        const nonOperating = obj(row, 'non_operating_interest');

        put(facts, INCOME_METRICS.revenue, num(row.sales) ?? num(row.revenue), currency, prov);
        put(facts, INCOME_METRICS.costOfRevenue, num(row.cost_of_goods), currency, prov);
        put(facts, INCOME_METRICS.grossProfit, num(row.gross_profit), currency, prov);
        put(facts, INCOME_METRICS.sellingGeneralAdministrative, num(opex.selling_general_and_administrative), currency, prov);
        put(facts, INCOME_METRICS.researchDevelopment, num(opex.research_and_development), currency, prov);
        // Vendors sometimes publish only the components; summing them is a
        // derivation and is labelled as one.
        {
          const total = num(row.total_operating_expense) ?? num(opex.total_operating_expense);
          if (total !== undefined) {
            put(facts, INCOME_METRICS.operatingExpenses, total, currency, prov);
          } else {
            const sga = num(opex.selling_general_and_administrative);
            const rnd = num(opex.research_and_development);
            if (sga !== undefined || rnd !== undefined) {
              put(facts, INCOME_METRICS.operatingExpenses, (sga ?? 0) + (rnd ?? 0), currency, prov, 'derived');
            }
          }
        }
        put(facts, INCOME_METRICS.operatingIncome, num(row.operating_income), currency, prov);
        put(facts, INCOME_METRICS.ebitda, num(row.ebitda), currency, prov);
        put(facts, INCOME_METRICS.ebit, num(row.ebit) ?? num(row.operating_income), currency, prov, num(row.ebit) !== undefined ? 'reported' : 'derived');
        put(facts, INCOME_METRICS.interestExpense, num(nonOperating.interest_expense) ?? num(row.interest_expense), currency, prov);
        put(facts, INCOME_METRICS.pretaxIncome, num(row.pretax_income), currency, prov);
        put(facts, INCOME_METRICS.incomeTax, num(row.income_tax), currency, prov);
        put(facts, INCOME_METRICS.netIncome, num(row.net_income), currency, prov);
        put(facts, INCOME_METRICS.eps, num(row.eps_basic), currency, prov);
        put(facts, INCOME_METRICS.epsDiluted, num(row.eps_diluted), currency, prov);
        put(facts, INCOME_METRICS.basicShares, num(row.basic_shares_outstanding), currency, prov);
        put(facts, INCOME_METRICS.dilutedShares, num(row.diluted_shares_outstanding), currency, prov);

        return { ...p, periodType, currency, facts };
      })
      .filter((p): p is StatementPeriod => p !== null);

    return finish(symbol, 'income', periodType, periods);
  }

  private async balanceSheet(symbol: string, periodType: PeriodType): Promise<FinancialStatement> {
    const body = await getJson<{ meta?: TdMeta; balance_sheet?: TdRow[] }>('/balance_sheet', {
      symbol,
      period: periodType,
    });
    const rows = rowsOf(body as Record<string, unknown>, 'balance_sheet');
    if (rows.length === 0) {
      throw new FundamentalsUnavailableError(`no ${periodType} balance sheet published for "${symbol}"`);
    }
    const currency = body.meta?.currency ?? 'USD';

    const periods = rows
      .map((row): StatementPeriod | null => {
        const p = periodOf(row, periodType);
        if (!p) return null;
        const prov = provenance(p.periodEnd);
        const facts: Record<string, FinancialFact> = {};

        const assets = obj(row, 'assets');
        const current = obj(assets, 'current_assets');
        const nonCurrent = obj(assets, 'non_current_assets');
        const liabilities = obj(row, 'liabilities');
        const currentLia = obj(liabilities, 'current_liabilities');
        const nonCurrentLia = obj(liabilities, 'non_current_liabilities');
        const equity = obj(row, 'shareholders_equity');

        put(facts, BALANCE_METRICS.cashAndEquivalents, num(current.cash) ?? num(current.cash_and_cash_equivalents), currency, prov);
        put(facts, BALANCE_METRICS.shortTermInvestments, num(current.cash_equivalents) ?? num(current.short_term_investments), currency, prov);
        put(facts, BALANCE_METRICS.accountsReceivable, num(current.accounts_receivable) ?? num(current.net_receivables), currency, prov);
        put(facts, BALANCE_METRICS.inventory, num(current.inventory), currency, prov);
        put(facts, BALANCE_METRICS.otherCurrentAssets, num(current.other_current_assets), currency, prov);
        put(facts, BALANCE_METRICS.totalCurrentAssets, num(current.total_current_assets), currency, prov);
        put(facts, BALANCE_METRICS.propertyPlantEquipment, num(nonCurrent.properties) ?? num(nonCurrent.property_plant_equipment), currency, prov);
        put(facts, BALANCE_METRICS.goodwill, num(nonCurrent.goodwill), currency, prov);
        put(facts, BALANCE_METRICS.intangibleAssets, num(nonCurrent.intangible_assets), currency, prov);
        put(facts, BALANCE_METRICS.longTermInvestments, num(nonCurrent.long_term_investments), currency, prov);
        put(facts, BALANCE_METRICS.otherNonCurrentAssets, num(nonCurrent.other_non_current_assets), currency, prov);
        put(facts, BALANCE_METRICS.totalAssets, num(assets.total_assets), currency, prov);

        put(facts, BALANCE_METRICS.accountsPayable, num(currentLia.accounts_payable), currency, prov);
        put(facts, BALANCE_METRICS.shortTermDebt, num(currentLia.short_term_debt) ?? num(currentLia.current_debt), currency, prov);
        put(facts, BALANCE_METRICS.otherCurrentLiabilities, num(currentLia.other_current_liabilities), currency, prov);
        put(facts, BALANCE_METRICS.totalCurrentLiabilities, num(currentLia.total_current_liabilities), currency, prov);
        put(facts, BALANCE_METRICS.longTermDebt, num(nonCurrentLia.long_term_debt), currency, prov);
        put(facts, BALANCE_METRICS.leaseLiabilities, num(nonCurrentLia.long_term_capital_lease_obligation) ?? num(nonCurrentLia.lease_liabilities), currency, prov);
        put(facts, BALANCE_METRICS.otherNonCurrentLiabilities, num(nonCurrentLia.other_non_current_liabilities), currency, prov);
        put(facts, BALANCE_METRICS.totalLiabilities, num(liabilities.total_liabilities), currency, prov);

        put(facts, BALANCE_METRICS.commonStock, num(equity.common_stock), currency, prov);
        put(facts, BALANCE_METRICS.additionalPaidInCapital, num(equity.additional_paid_in_capital), currency, prov);
        put(facts, BALANCE_METRICS.retainedEarnings, num(equity.retained_earnings), currency, prov);
        put(facts, BALANCE_METRICS.treasuryStock, num(equity.treasury_stock), currency, prov);
        put(facts, BALANCE_METRICS.otherComprehensiveIncome, num(equity.other_shareholders_equity) ?? num(equity.accumulated_other_comprehensive_income), currency, prov);
        put(facts, BALANCE_METRICS.totalEquity, num(equity.total_shareholders_equity), currency, prov);

        // The identity's right-hand side. DERIVED and labelled — it is the
        // number the reconciliation check compares against total assets, and
        // presenting it as reported would hide which side the vendor published.
        const totalLia = num(liabilities.total_liabilities);
        const totalEq = num(equity.total_shareholders_equity);
        if (totalLia !== undefined && totalEq !== undefined) {
          put(facts, BALANCE_METRICS.totalLiabilitiesAndEquity, totalLia + totalEq, currency, prov, 'derived');
        }

        return { ...p, periodType, currency, facts };
      })
      .filter((p): p is StatementPeriod => p !== null);

    return finish(symbol, 'balance', periodType, periods);
  }

  private async cashFlow(symbol: string, periodType: PeriodType): Promise<FinancialStatement> {
    const body = await getJson<{ meta?: TdMeta; cash_flow?: TdRow[] }>('/cash_flow', { symbol, period: periodType });
    const rows = rowsOf(body as Record<string, unknown>, 'cash_flow');
    if (rows.length === 0) {
      throw new FundamentalsUnavailableError(`no ${periodType} cash-flow statement published for "${symbol}"`);
    }
    const currency = body.meta?.currency ?? 'USD';

    const periods = rows
      .map((row): StatementPeriod | null => {
        const p = periodOf(row, periodType);
        if (!p) return null;
        const prov = provenance(p.periodEnd);
        const facts: Record<string, FinancialFact> = {};

        const operating = obj(row, 'operating_activities');
        const investing = obj(row, 'investing_activities');
        const financing = obj(row, 'financing_activities');

        put(facts, CASH_FLOW_METRICS.netIncome, num(operating.net_income), currency, prov);
        put(facts, CASH_FLOW_METRICS.depreciationAmortization, num(operating.depreciation), currency, prov);
        put(facts, CASH_FLOW_METRICS.stockBasedCompensation, num(operating.stock_based_compensation) ?? num(operating.other_non_cash_items), currency, prov);
        put(facts, CASH_FLOW_METRICS.changeInWorkingCapital, num(operating.change_in_working_capital), currency, prov);
        const ocf = num(row.operating_cash_flow) ?? num(operating.operating_cash_flow);
        put(facts, CASH_FLOW_METRICS.operatingCashFlow, ocf, currency, prov);

        const capex = num(investing.capital_expenditures) ?? num(row.capital_expenditures);
        put(facts, CASH_FLOW_METRICS.capitalExpenditure, capex, currency, prov);
        put(facts, CASH_FLOW_METRICS.investingCashFlow, num(row.investing_cash_flow) ?? num(investing.investing_cash_flow), currency, prov);

        put(facts, CASH_FLOW_METRICS.debtIssuanceRepayment, num(financing.long_term_debt_issuance) ?? num(financing.net_borrowings), currency, prov);
        put(facts, CASH_FLOW_METRICS.shareIssuanceRepurchase, num(financing.common_stock_issuance) ?? num(financing.repurchase_of_capital_stock), currency, prov);
        put(facts, CASH_FLOW_METRICS.dividendsPaid, num(financing.dividend_payout) ?? num(financing.dividends_paid), currency, prov);
        put(facts, CASH_FLOW_METRICS.financingCashFlow, num(row.financing_cash_flow) ?? num(financing.financing_cash_flow), currency, prov);

        put(facts, CASH_FLOW_METRICS.netChangeInCash, num(row.net_change_in_cash) ?? num(row.end_cash_position), currency, prov);

        // Free cash flow: reported when the vendor publishes it, otherwise the
        // standard derivation. CapEx is filed as a negative outflow by most
        // issuers and as a positive cost by some, so the magnitude is
        // subtracted rather than the signed value — adding a negative capex
        // would report FCF ABOVE operating cash flow, which is the kind of
        // plausible-but-wrong number this whole subsystem exists to prevent.
        const reportedFcf = num(row.free_cash_flow);
        if (reportedFcf !== undefined) {
          put(facts, CASH_FLOW_METRICS.freeCashFlow, reportedFcf, currency, prov);
        } else if (ocf !== undefined && capex !== undefined) {
          put(facts, CASH_FLOW_METRICS.freeCashFlow, ocf - Math.abs(capex), currency, prov, 'derived');
        }

        return { ...p, periodType, currency, facts };
      })
      .filter((p): p is StatementPeriod => p !== null);

    return finish(symbol, 'cash_flow', periodType, periods);
  }

  /**
   * Twelve Data publishes no shareholding register on any plan this repository
   * is provisioned for. Throwing is the honest answer — the alternative, an
   * empty breakdown, would render as "0% promoters" and repeat the exact defect
   * this subsystem replaced.
   */
  async getOwnership(_symbol: string): Promise<OwnershipBreakdown> {
    throw new FundamentalsUnavailableError(
      'the configured data provider (twelvedata) publishes no shareholding register',
    );
  }

  /** Same as ownership: no segment reporting on this vendor's plans. */
  async getSegments(_symbol: string): Promise<SegmentBreakdown[]> {
    throw new FundamentalsUnavailableError(
      'the configured data provider (twelvedata) publishes no segment reporting',
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await getJson<TdRow>('/symbol_search', { symbol: 'AAPL', outputsize: 1 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Sort newest-first and reject a statement that normalized to nothing.
 *
 * A response whose rows all failed to yield a period end is an unavailability,
 * not an empty company: returning `{ periods: [] }` here would let the UI render
 * a statement table with headers and no rows, which reads as "this company files
 * nothing" rather than "we could not parse the vendor's answer".
 */
function finish(
  symbol: string,
  statementType: StatementType,
  periodType: PeriodType,
  periods: StatementPeriod[],
): FinancialStatement {
  if (periods.length === 0) {
    throw new FundamentalsUnavailableError(
      `the provider's ${periodType} ${statementType.replace('_', ' ')} response for "${symbol}" carried no readable periods`,
    );
  }
  periods.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  return { statementType, periodType, symbol, periods };
}
