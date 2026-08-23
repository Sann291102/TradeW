/**
 * Fundamental ratios — computed, never quoted.
 *
 * Every ratio here is derived from statement facts this system actually holds,
 * and every one carries the formula it was computed with plus the exact inputs
 * that went into it. That is the whole point of the module: the surface it
 * feeds used to print `P/E Ratio (TTM) 24.62` as a literal, so a ratio that
 * cannot show its working is indistinguishable from that.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────
 *
 * 1. A ratio whose inputs are missing is ABSENT from the result. Not zero, not
 *    null, not '—'. `computeRatios` returns only what it could compute.
 * 2. A ratio whose denominator is zero (or, where the sign would make the
 *    result meaningless — negative equity, negative EBITDA) is ABSENT, with the
 *    reason recorded in `skipped` so the UI can say why rather than leave a
 *    silent hole.
 * 3. Nothing here reaches for a vendor's own ratio. The vendor's trailing P/E
 *    travels separately on `CompanyStatistics` and is displayed as the vendor's,
 *    never merged into these.
 * 4. Forward-looking ratios (forward P/E, PEG) are NOT computed. This system
 *    holds no earnings estimates; a "forward" number derived from trailing data
 *    would be a fabrication wearing a forward label. Where the vendor publishes
 *    its own, the UI shows it attributed to the vendor.
 */

import {
  BALANCE_METRICS,
  CASH_FLOW_METRICS,
  INCOME_METRICS,
  type StatementPeriod,
} from './fundamentals.contract';

/** Which family a ratio belongs to — drives the UI's grouping. */
export type RatioGroup = 'valuation' | 'profitability' | 'health' | 'growth';

export interface RatioInput {
  label: string;
  value: number;
}

export interface ComputedRatio {
  key: string;
  label: string;
  group: RatioGroup;
  value: number;
  /** 'x' = multiple, 'percent', 'ratio', 'currency'. Drives formatting only. */
  unit: 'x' | 'percent' | 'ratio' | 'currency';
  /** Human-readable formula, shown in the UI beside the number. */
  formula: string;
  /** The exact operands used, so a reader can check the arithmetic. */
  inputs: RatioInput[];
  /** ISO period end of the statement data used. */
  periodEnd: string;
}

/** A ratio that could not be computed, and precisely why. */
export interface SkippedRatio {
  key: string;
  label: string;
  group: RatioGroup;
  reason: string;
}

export interface RatioResult {
  ratios: ComputedRatio[];
  skipped: SkippedRatio[];
}

/** Market-side inputs the statements do not contain. All optional — a ratio
 *  needing one it does not get is skipped, not guessed. */
export interface MarketInputs {
  price?: number;
  marketCap?: number;
  enterpriseValue?: number;
  sharesOutstanding?: number;
}

/** Read one metric out of a period. Returns undefined for an absent key —
 *  which is the whole contract; see `fundamentals.contract.ts`. */
function fact(period: StatementPeriod | undefined, metric: string): number | undefined {
  const f = period?.facts[metric];
  return f ? f.value : undefined;
}

interface Spec {
  key: string;
  label: string;
  group: RatioGroup;
  unit: ComputedRatio['unit'];
  formula: string;
  /** Named operands. An undefined operand skips the ratio with a precise reason. */
  operands: Record<string, number | undefined>;
  compute: (o: Record<string, number>) => number;
  /**
   * Extra guard beyond "all operands present". Return a reason string to skip.
   * Used for zero and sign conditions that would produce a meaningless number.
   */
  guard?: (o: Record<string, number>) => string | null;
}

function build(specs: Spec[], periodEnd: string): RatioResult {
  const ratios: ComputedRatio[] = [];
  const skipped: SkippedRatio[] = [];

  for (const spec of specs) {
    const missing = Object.entries(spec.operands)
      .filter(([, v]) => v === undefined || !Number.isFinite(v))
      .map(([k]) => k);

    if (missing.length > 0) {
      skipped.push({
        key: spec.key,
        label: spec.label,
        group: spec.group,
        reason: `not reported: ${missing.join(', ')}`,
      });
      continue;
    }

    const resolved = spec.operands as Record<string, number>;
    const guardReason = spec.guard?.(resolved) ?? null;
    if (guardReason) {
      skipped.push({ key: spec.key, label: spec.label, group: spec.group, reason: guardReason });
      continue;
    }

    const value = spec.compute(resolved);
    if (!Number.isFinite(value)) {
      skipped.push({
        key: spec.key,
        label: spec.label,
        group: spec.group,
        reason: 'calculation did not produce a finite number',
      });
      continue;
    }

    ratios.push({
      key: spec.key,
      label: spec.label,
      group: spec.group,
      value,
      unit: spec.unit,
      formula: spec.formula,
      inputs: Object.entries(resolved).map(([label, v]) => ({ label, value: v })),
      periodEnd,
    });
  }

  return { ratios, skipped };
}

/** Guard helper: skip when a denominator is zero. */
const nonZero = (name: string) => (o: Record<string, number>) =>
  o[name] === 0 ? `${name} is zero` : null;

/** Guard helper: skip when a value must be positive to be meaningful. */
const mustBePositive = (name: string, why: string) => (o: Record<string, number>) =>
  o[name] <= 0 ? `${name} is ${o[name] <= 0 ? 'not positive' : 'invalid'} — ${why}` : null;

/**
 * Compute every ratio the available data supports.
 *
 * `latest` / `previous` are the two most recent periods of the SAME cadence —
 * mixing an annual with a quarterly would produce growth rates off by a factor
 * of four, so the caller is responsible for passing a consistent pair and the
 * growth block is skipped entirely when `previous` is absent.
 */
export function computeRatios(input: {
  income?: StatementPeriod;
  incomePrevious?: StatementPeriod;
  balance?: StatementPeriod;
  balancePrevious?: StatementPeriod;
  cashFlow?: StatementPeriod;
  cashFlowPrevious?: StatementPeriod;
  market?: MarketInputs;
}): RatioResult {
  const { income, incomePrevious, balance, balancePrevious, cashFlow, cashFlowPrevious, market = {} } = input;
  const periodEnd = income?.periodEnd ?? balance?.periodEnd ?? cashFlow?.periodEnd ?? '';

  // ── income statement ──
  const revenue = fact(income, INCOME_METRICS.revenue);
  const grossProfit = fact(income, INCOME_METRICS.grossProfit);
  const operatingIncome = fact(income, INCOME_METRICS.operatingIncome);
  const netIncome = fact(income, INCOME_METRICS.netIncome);
  const ebitda = fact(income, INCOME_METRICS.ebitda);
  const ebit = fact(income, INCOME_METRICS.ebit);
  const interestExpense = fact(income, INCOME_METRICS.interestExpense);
  const pretaxIncome = fact(income, INCOME_METRICS.pretaxIncome);
  const incomeTax = fact(income, INCOME_METRICS.incomeTax);
  const eps = fact(income, INCOME_METRICS.eps);

  // ── balance sheet ──
  const totalAssets = fact(balance, BALANCE_METRICS.totalAssets);
  const totalEquity = fact(balance, BALANCE_METRICS.totalEquity);
  const totalLiabilities = fact(balance, BALANCE_METRICS.totalLiabilities);
  const currentAssets = fact(balance, BALANCE_METRICS.totalCurrentAssets);
  const currentLiabilities = fact(balance, BALANCE_METRICS.totalCurrentLiabilities);
  const inventory = fact(balance, BALANCE_METRICS.inventory);
  const cash = fact(balance, BALANCE_METRICS.cashAndEquivalents);
  const shortTermDebt = fact(balance, BALANCE_METRICS.shortTermDebt);
  const longTermDebt = fact(balance, BALANCE_METRICS.longTermDebt);
  const assetsPrev = fact(balancePrevious, BALANCE_METRICS.totalAssets);
  const equityPrev = fact(balancePrevious, BALANCE_METRICS.totalEquity);

  // ── cash flow ──
  const operatingCashFlow = fact(cashFlow, CASH_FLOW_METRICS.operatingCashFlow);
  const freeCashFlow = fact(cashFlow, CASH_FLOW_METRICS.freeCashFlow);
  const freeCashFlowPrev = fact(cashFlowPrevious, CASH_FLOW_METRICS.freeCashFlow);

  // ── previous-period income, for growth ──
  const revenuePrev = fact(incomePrevious, INCOME_METRICS.revenue);
  const epsPrev = fact(incomePrevious, INCOME_METRICS.eps);
  const ebitdaPrev = fact(incomePrevious, INCOME_METRICS.ebitda);

  // Total debt is a derivation, so it is only formed when at least one
  // component exists; treating an absent long-term debt line as zero would
  // understate leverage for an issuer that simply did not break it out.
  const totalDebt =
    shortTermDebt === undefined && longTermDebt === undefined
      ? undefined
      : (shortTermDebt ?? 0) + (longTermDebt ?? 0);
  const netDebt = totalDebt === undefined || cash === undefined ? undefined : totalDebt - cash;

  // Average balances for return ratios. Falls back to the point-in-time figure
  // when there is no prior period — labelled in the formula so the reader knows
  // which was used rather than assuming an average.
  const avgAssets =
    totalAssets !== undefined && assetsPrev !== undefined ? (totalAssets + assetsPrev) / 2 : totalAssets;
  const avgEquity =
    totalEquity !== undefined && equityPrev !== undefined ? (totalEquity + equityPrev) / 2 : totalEquity;
  const usedAvgAssets = totalAssets !== undefined && assetsPrev !== undefined;
  const usedAvgEquity = totalEquity !== undefined && equityPrev !== undefined;

  // Effective tax rate, for NOPAT in ROIC. Skipped rather than assumed at 25%.
  const taxRate =
    pretaxIncome !== undefined && incomeTax !== undefined && pretaxIncome !== 0
      ? incomeTax / pretaxIncome
      : undefined;
  const investedCapital =
    totalEquity === undefined || totalDebt === undefined ? undefined : totalEquity + totalDebt;

  const specs: Spec[] = [
    // ── valuation ──
    {
      key: 'pe',
      label: 'P/E',
      group: 'valuation',
      unit: 'x',
      formula: 'Price ÷ EPS',
      operands: { price: market.price, eps },
      guard: (o) => (o.eps <= 0 ? 'EPS is not positive — a P/E multiple would be meaningless' : null),
      compute: (o) => o.price / o.eps,
    },
    {
      key: 'ps',
      label: 'P/S',
      group: 'valuation',
      unit: 'x',
      formula: 'Market capitalisation ÷ Revenue',
      operands: { marketCap: market.marketCap, revenue },
      guard: nonZero('revenue'),
      compute: (o) => o.marketCap / o.revenue,
    },
    {
      key: 'pb',
      label: 'P/B',
      group: 'valuation',
      unit: 'x',
      formula: "Market capitalisation ÷ Total shareholders' equity",
      operands: { marketCap: market.marketCap, totalEquity },
      guard: mustBePositive('totalEquity', 'book value is negative'),
      compute: (o) => o.marketCap / o.totalEquity,
    },
    {
      key: 'ev_revenue',
      label: 'EV / Revenue',
      group: 'valuation',
      unit: 'x',
      formula: 'Enterprise value ÷ Revenue',
      operands: { enterpriseValue: market.enterpriseValue, revenue },
      guard: nonZero('revenue'),
      compute: (o) => o.enterpriseValue / o.revenue,
    },
    {
      key: 'ev_ebitda',
      label: 'EV / EBITDA',
      group: 'valuation',
      unit: 'x',
      formula: 'Enterprise value ÷ EBITDA',
      operands: { enterpriseValue: market.enterpriseValue, ebitda },
      guard: mustBePositive('ebitda', 'the multiple is not interpretable'),
      compute: (o) => o.enterpriseValue / o.ebitda,
    },

    // ── profitability ──
    {
      key: 'gross_margin',
      label: 'Gross margin',
      group: 'profitability',
      unit: 'percent',
      formula: 'Gross profit ÷ Revenue',
      operands: { grossProfit, revenue },
      guard: nonZero('revenue'),
      compute: (o) => (o.grossProfit / o.revenue) * 100,
    },
    {
      key: 'operating_margin',
      label: 'Operating margin',
      group: 'profitability',
      unit: 'percent',
      formula: 'Operating income ÷ Revenue',
      operands: { operatingIncome, revenue },
      guard: nonZero('revenue'),
      compute: (o) => (o.operatingIncome / o.revenue) * 100,
    },
    {
      key: 'net_margin',
      label: 'Net margin',
      group: 'profitability',
      unit: 'percent',
      formula: 'Net income ÷ Revenue',
      operands: { netIncome, revenue },
      guard: nonZero('revenue'),
      compute: (o) => (o.netIncome / o.revenue) * 100,
    },
    {
      key: 'roe',
      label: 'Return on equity',
      group: 'profitability',
      unit: 'percent',
      formula: usedAvgEquity
        ? "Net income ÷ average shareholders' equity (opening + closing ÷ 2)"
        : "Net income ÷ shareholders' equity (single period — no prior balance sheet)",
      operands: { netIncome, equity: avgEquity },
      guard: mustBePositive('equity', 'return on negative equity is not interpretable'),
      compute: (o) => (o.netIncome / o.equity) * 100,
    },
    {
      key: 'roa',
      label: 'Return on assets',
      group: 'profitability',
      unit: 'percent',
      formula: usedAvgAssets
        ? 'Net income ÷ average total assets (opening + closing ÷ 2)'
        : 'Net income ÷ total assets (single period — no prior balance sheet)',
      operands: { netIncome, assets: avgAssets },
      guard: nonZero('assets'),
      compute: (o) => (o.netIncome / o.assets) * 100,
    },
    {
      key: 'roic',
      label: 'Return on invested capital',
      group: 'profitability',
      unit: 'percent',
      formula: 'EBIT × (1 − effective tax rate) ÷ (Total debt + Total equity)',
      operands: { ebit, taxRate, investedCapital },
      guard: mustBePositive('investedCapital', 'invested capital is not positive'),
      compute: (o) => ((o.ebit * (1 - o.taxRate)) / o.investedCapital) * 100,
    },

    // ── financial health ──
    {
      key: 'debt_equity',
      label: 'Debt / Equity',
      group: 'health',
      unit: 'ratio',
      formula: "Total debt (short-term + long-term) ÷ Total shareholders' equity",
      operands: { totalDebt, totalEquity },
      guard: mustBePositive('totalEquity', 'gearing against negative equity is not interpretable'),
      compute: (o) => o.totalDebt / o.totalEquity,
    },
    {
      key: 'net_debt_ebitda',
      label: 'Net debt / EBITDA',
      group: 'health',
      unit: 'x',
      formula: 'Net debt (Total debt − Cash) ÷ EBITDA',
      operands: { netDebt, ebitda },
      guard: mustBePositive('ebitda', 'leverage against negative EBITDA is not interpretable'),
      compute: (o) => o.netDebt / o.ebitda,
    },
    {
      key: 'current_ratio',
      label: 'Current ratio',
      group: 'health',
      unit: 'ratio',
      formula: 'Total current assets ÷ Total current liabilities',
      operands: { currentAssets, currentLiabilities },
      guard: nonZero('currentLiabilities'),
      compute: (o) => o.currentAssets / o.currentLiabilities,
    },
    {
      key: 'quick_ratio',
      label: 'Quick ratio',
      group: 'health',
      unit: 'ratio',
      formula: '(Total current assets − Inventory) ÷ Total current liabilities',
      operands: { currentAssets, inventory, currentLiabilities },
      guard: nonZero('currentLiabilities'),
      compute: (o) => (o.currentAssets - o.inventory) / o.currentLiabilities,
    },
    {
      key: 'interest_coverage',
      label: 'Interest coverage',
      group: 'health',
      unit: 'x',
      formula: 'EBIT ÷ Interest expense',
      operands: { ebit, interestExpense },
      // Vendors publish interest expense as a positive cost or a negative
      // charge depending on the filing; the magnitude is what the ratio needs,
      // and a zero means there is no interest to cover.
      guard: (o) => (Math.abs(o.interestExpense) === 0 ? 'no interest expense reported' : null),
      compute: (o) => o.ebit / Math.abs(o.interestExpense),
    },

    // ── growth (period over period, same cadence) ──
    {
      key: 'revenue_growth',
      label: 'Revenue growth',
      group: 'growth',
      unit: 'percent',
      formula: '(Revenue − prior-period revenue) ÷ |prior-period revenue|',
      operands: { revenue, revenuePrev },
      guard: nonZero('revenuePrev'),
      compute: (o) => ((o.revenue - o.revenuePrev) / Math.abs(o.revenuePrev)) * 100,
    },
    {
      key: 'eps_growth',
      label: 'EPS growth',
      group: 'growth',
      unit: 'percent',
      formula: '(EPS − prior-period EPS) ÷ |prior-period EPS|',
      operands: { eps, epsPrev },
      guard: nonZero('epsPrev'),
      compute: (o) => ((o.eps - o.epsPrev) / Math.abs(o.epsPrev)) * 100,
    },
    {
      key: 'ebitda_growth',
      label: 'EBITDA growth',
      group: 'growth',
      unit: 'percent',
      formula: '(EBITDA − prior-period EBITDA) ÷ |prior-period EBITDA|',
      operands: { ebitda, ebitdaPrev },
      guard: nonZero('ebitdaPrev'),
      compute: (o) => ((o.ebitda - o.ebitdaPrev) / Math.abs(o.ebitdaPrev)) * 100,
    },
    {
      key: 'fcf_growth',
      label: 'Free cash flow growth',
      group: 'growth',
      unit: 'percent',
      formula: '(FCF − prior-period FCF) ÷ |prior-period FCF|',
      operands: { freeCashFlow, freeCashFlowPrev },
      guard: nonZero('freeCashFlowPrev'),
      compute: (o) => ((o.freeCashFlow - o.freeCashFlowPrev) / Math.abs(o.freeCashFlowPrev)) * 100,
    },
    {
      key: 'fcf_conversion',
      label: 'FCF conversion',
      group: 'health',
      unit: 'percent',
      formula: 'Free cash flow ÷ Operating cash flow',
      operands: { freeCashFlow, operatingCashFlow },
      guard: nonZero('operatingCashFlow'),
      compute: (o) => (o.freeCashFlow / o.operatingCashFlow) * 100,
    },
  ];

  // `totalLiabilities` participates only in reconciliation, not in a ratio;
  // referenced here so the destructure above stays honest about what is read.
  void totalLiabilities;

  return build(specs, periodEnd);
}
