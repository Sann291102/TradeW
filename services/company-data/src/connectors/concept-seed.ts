/**
 * The canonical chart of accounts, and the in-bse-fin tags that feed it.
 *
 * ── WHY THIS IS DATA AND NOT A switch STATEMENT ────────────────────────────
 * Every entry here becomes a `FinancialConcept` or `ConceptMapping` row. That
 * matters because normalisation rules are the part of this pipeline most likely
 * to be wrong, and rules in a database can be inspected, diffed and corrected
 * without redeploying a parser. It also means a mapping can be added for a tag a
 * filer used that nobody anticipated — which will happen, because 2,550
 * companies use different subsets of the taxonomy.
 *
 * ── DELIBERATELY PARTIAL ───────────────────────────────────────────────────
 * This covers the lines a research page actually renders. RELIANCE's annual
 * consolidated filing alone carries ~200 numeric tags in its cumulative column;
 * mapping every one before shipping anything would be weeks of work to display
 * lines nobody asked for.
 *
 * An unmapped tag is NOT dropped. It is stored with `conceptKey = null` beside
 * its raw tag and counted as a coverage finding, so "what are we not yet
 * reading" is a query rather than a guess. That is the whole reason the line
 * item table keeps `rawTag`.
 *
 * ── SIGN ───────────────────────────────────────────────────────────────────
 * `sign` is +1 when a positive value increases its subtotal and -1 when it
 * reduces it. NSE's filings report expenses as POSITIVE numbers under a
 * positive `Expenses` subtotal, so expense concepts carry sign -1 relative to
 * profit and the arithmetic is applied once, here, rather than in every
 * consumer that adds a column up.
 */

export const SOURCE_VOCABULARY = 'nse-xbrl-in-bse-fin';

export interface ConceptSeed {
  conceptKey: string;
  statement: 'PL' | 'BS' | 'CF';
  label: string;
  parentKey?: string;
  sign?: number;
  isSubtotal?: boolean;
  ordinal: number;
  /** in-bse-fin tags that mean this concept. */
  tags: string[];
}

export const CONCEPTS: ConceptSeed[] = [
  // ── Profit & loss ────────────────────────────────────────────────────────
  { conceptKey: 'pl.revenue.operating', statement: 'PL', label: 'Revenue from operations', ordinal: 10, tags: ['RevenueFromOperations'] },
  { conceptKey: 'pl.revenue.other', statement: 'PL', label: 'Other income', ordinal: 20, tags: ['OtherIncome'] },
  { conceptKey: 'pl.revenue.total', statement: 'PL', label: 'Total income', isSubtotal: true, ordinal: 30, tags: ['Income'] },

  { conceptKey: 'pl.expense.materials', statement: 'PL', label: 'Cost of materials consumed', parentKey: 'pl.expense.total', sign: -1, ordinal: 40, tags: ['CostOfMaterialsConsumed'] },
  { conceptKey: 'pl.expense.purchases', statement: 'PL', label: 'Purchases of stock-in-trade', parentKey: 'pl.expense.total', sign: -1, ordinal: 50, tags: ['PurchasesOfStockInTrade'] },
  {
    conceptKey: 'pl.expense.inventory-change',
    statement: 'PL',
    label: 'Changes in inventories',
    parentKey: 'pl.expense.total',
    sign: -1,
    ordinal: 60,
    // Genuinely signed either way: inventory can rise or fall, so this line is
    // negative in a good year and positive in a bad one. Not an error.
    tags: ['ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade'],
  },
  { conceptKey: 'pl.expense.employee', statement: 'PL', label: 'Employee benefit expense', parentKey: 'pl.expense.total', sign: -1, ordinal: 70, tags: ['EmployeeBenefitExpense'] },
  { conceptKey: 'pl.expense.finance', statement: 'PL', label: 'Finance costs', parentKey: 'pl.expense.total', sign: -1, ordinal: 80, tags: ['FinanceCosts'] },
  { conceptKey: 'pl.expense.depreciation', statement: 'PL', label: 'Depreciation and amortisation', parentKey: 'pl.expense.total', sign: -1, ordinal: 90, tags: ['DepreciationDepletionAndAmortisationExpense'] },
  { conceptKey: 'pl.expense.other', statement: 'PL', label: 'Other expenses', parentKey: 'pl.expense.total', sign: -1, ordinal: 100, tags: ['OtherExpenses'] },
  { conceptKey: 'pl.expense.total', statement: 'PL', label: 'Total expenses', sign: -1, isSubtotal: true, ordinal: 110, tags: ['Expenses'] },

  { conceptKey: 'pl.pbt.before-exceptional', statement: 'PL', label: 'Profit before exceptional items and tax', isSubtotal: true, ordinal: 120, tags: ['ProfitBeforeExceptionalItemsAndTax'] },
  { conceptKey: 'pl.exceptional', statement: 'PL', label: 'Exceptional items', ordinal: 130, tags: ['ExceptionalItemsBeforeTax'] },
  { conceptKey: 'pl.pbt', statement: 'PL', label: 'Profit before tax', isSubtotal: true, ordinal: 140, tags: ['ProfitBeforeTax'] },

  { conceptKey: 'pl.tax.current', statement: 'PL', label: 'Current tax', parentKey: 'pl.tax.total', sign: -1, ordinal: 150, tags: ['CurrentTax'] },
  { conceptKey: 'pl.tax.deferred', statement: 'PL', label: 'Deferred tax', parentKey: 'pl.tax.total', sign: -1, ordinal: 160, tags: ['DeferredTax'] },
  { conceptKey: 'pl.tax.total', statement: 'PL', label: 'Total tax expense', sign: -1, isSubtotal: true, ordinal: 170, tags: ['TaxExpense'] },

  { conceptKey: 'pl.pat.continuing', statement: 'PL', label: 'Profit from continuing operations', ordinal: 180, tags: ['ProfitLossForPeriodFromContinuingOperations'] },
  { conceptKey: 'pl.pat.discontinued', statement: 'PL', label: 'Profit from discontinued operations', ordinal: 190, tags: ['ProfitLossFromDiscontinuedOperationsAfterTax'] },
  { conceptKey: 'pl.associates', statement: 'PL', label: 'Share of profit of associates and JVs', ordinal: 195, tags: ['ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod'] },
  { conceptKey: 'pl.pat', statement: 'PL', label: 'Net profit for the period', isSubtotal: true, ordinal: 200, tags: ['ProfitLossForPeriod'] },
  // Consolidated filings split the group result between the parent's owners and
  // minorities. A page that shows group PAT where it means owners' PAT
  // overstates what accrues to the shareholder it is being shown to.
  { conceptKey: 'pl.pat.owners', statement: 'PL', label: 'Profit attributable to owners of the parent', ordinal: 205, tags: ['ProfitOrLossAttributableToOwnersOfParent'] },
  { conceptKey: 'pl.pat.minorities', statement: 'PL', label: 'Profit attributable to non-controlling interests', ordinal: 206, tags: ['ProfitOrLossAttributableToNonControllingInterests'] },

  { conceptKey: 'pl.oci', statement: 'PL', label: 'Other comprehensive income', ordinal: 210, tags: ['OtherComprehensiveIncomeNetOfTaxes'] },
  { conceptKey: 'pl.comprehensive', statement: 'PL', label: 'Total comprehensive income', isSubtotal: true, ordinal: 220, tags: ['ComprehensiveIncomeForThePeriod'] },

  { conceptKey: 'pl.eps.basic', statement: 'PL', label: 'Basic EPS', ordinal: 230, tags: ['BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations'] },
  { conceptKey: 'pl.eps.diluted', statement: 'PL', label: 'Diluted EPS', ordinal: 240, tags: ['DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations'] },

  // The pair that yields a SHARE COUNT, and therefore market cap:
  //   shares = PaidUpValueOfEquityShareCapital / FaceValueOfEquityShareCapital
  // Both are in ₹, so the quotient is a count. This is the free route to market
  // cap, and the reason it was left null in Phase 2 rather than approximated.
  { conceptKey: 'equity.paid-up-capital', statement: 'PL', label: 'Paid-up equity share capital', ordinal: 250, tags: ['PaidUpValueOfEquityShareCapital'] },
  { conceptKey: 'equity.face-value', statement: 'PL', label: 'Face value per share', ordinal: 260, tags: ['FaceValueOfEquityShareCapital'] },
  { conceptKey: 'pl.reserves', statement: 'PL', label: 'Reserves excluding revaluation reserves', ordinal: 270, tags: ['ReserveExcludingRevaluationReserves'] },

  // ── Balance sheet (annual filings only) ──────────────────────────────────
  { conceptKey: 'bs.assets.noncurrent', statement: 'BS', label: 'Non-current assets', parentKey: 'bs.assets.total', isSubtotal: true, ordinal: 10, tags: ['NoncurrentAssets'] },
  { conceptKey: 'bs.assets.current', statement: 'BS', label: 'Current assets', parentKey: 'bs.assets.total', isSubtotal: true, ordinal: 20, tags: ['CurrentAssets'] },
  { conceptKey: 'bs.assets.total', statement: 'BS', label: 'Total assets', isSubtotal: true, ordinal: 30, tags: ['Assets'] },
  { conceptKey: 'bs.assets.inventories', statement: 'BS', label: 'Inventories', parentKey: 'bs.assets.current', ordinal: 40, tags: ['Inventories'] },
  { conceptKey: 'bs.assets.receivables', statement: 'BS', label: 'Trade receivables', parentKey: 'bs.assets.current', ordinal: 50, tags: ['TradeReceivablesCurrent'] },

  { conceptKey: 'bs.equity.share-capital', statement: 'BS', label: 'Equity share capital', parentKey: 'bs.equity.total', ordinal: 60, tags: ['EquityShareCapital'] },
  { conceptKey: 'bs.equity.other', statement: 'BS', label: 'Other equity', parentKey: 'bs.equity.total', ordinal: 70, tags: ['OtherEquity'] },
  { conceptKey: 'bs.equity.total', statement: 'BS', label: 'Total equity', isSubtotal: true, ordinal: 80, tags: ['Equity'] },
  { conceptKey: 'bs.equity.owners', statement: 'BS', label: 'Equity attributable to owners of the parent', parentKey: 'bs.equity.total', ordinal: 85, tags: ['EquityAttributableToOwnersOfParent'] },

  { conceptKey: 'bs.liabilities.noncurrent', statement: 'BS', label: 'Non-current liabilities', parentKey: 'bs.liabilities.total', isSubtotal: true, ordinal: 90, tags: ['NoncurrentLiabilities'] },
  { conceptKey: 'bs.liabilities.current', statement: 'BS', label: 'Current liabilities', parentKey: 'bs.liabilities.total', isSubtotal: true, ordinal: 100, tags: ['CurrentLiabilities'] },
  { conceptKey: 'bs.liabilities.total', statement: 'BS', label: 'Total liabilities', isSubtotal: true, ordinal: 110, tags: ['Liabilities'] },
  { conceptKey: 'bs.equity-and-liabilities.total', statement: 'BS', label: 'Total equity and liabilities', isSubtotal: true, ordinal: 120, tags: ['EquityAndLiabilities'] },

  // ── Cash flow (annual filings only) ──────────────────────────────────────
  { conceptKey: 'cf.operating', statement: 'CF', label: 'Net cash from operating activities', isSubtotal: true, ordinal: 10, tags: ['CashFlowsFromUsedInOperatingActivities'] },
  { conceptKey: 'cf.investing', statement: 'CF', label: 'Net cash from investing activities', isSubtotal: true, ordinal: 20, tags: ['CashFlowsFromUsedInInvestingActivities'] },
  { conceptKey: 'cf.financing', statement: 'CF', label: 'Net cash from financing activities', isSubtotal: true, ordinal: 30, tags: ['CashFlowsFromUsedInFinancingActivities'] },
  { conceptKey: 'cf.operations', statement: 'CF', label: 'Cash generated from operations', ordinal: 15, tags: ['CashFlowsFromUsedInOperations'] },
  {
    conceptKey: 'cf.capex',
    statement: 'CF',
    label: 'Purchase of property, plant and equipment',
    parentKey: 'cf.investing',
    sign: -1,
    ordinal: 40,
    tags: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  },
  {
    conceptKey: 'cf.net-change-before-fx',
    statement: 'CF',
    label: 'Net increase/(decrease) in cash before exchange differences',
    isSubtotal: true,
    ordinal: 45,
    // The line that CFO + CFI + CFF must equal. The FX effect is applied AFTER
    // it, so validating the three activity totals against the post-FX figure
    // would fail for every company with foreign operations.
    tags: ['IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges'],
  },
  { conceptKey: 'cf.fx-effect', statement: 'CF', label: 'Effect of exchange rate changes on cash', ordinal: 48, tags: ['EffectOfExchangeRateChangesOnCashAndCashEquivalents'] },
  { conceptKey: 'cf.net-change', statement: 'CF', label: 'Net increase/(decrease) in cash', isSubtotal: true, ordinal: 50, tags: ['IncreaseDecreaseInCashAndCashEquivalents'] },
  { conceptKey: 'cf.closing-balance', statement: 'CF', label: 'Cash and cash equivalents at period end', ordinal: 55, tags: ['CashAndCashEquivalentsCashFlowStatement'] },
  { conceptKey: 'cf.interest-paid', statement: 'CF', label: 'Interest paid', parentKey: 'cf.operating', sign: -1, ordinal: 13, tags: ['InterestPaidClassifiedAsOperatingActivities'] },
  { conceptKey: 'cf.tax-paid', statement: 'CF', label: 'Income taxes paid', parentKey: 'cf.operating', sign: -1, ordinal: 14, tags: ['IncomeTaxesPaidRefundClassifiedAsOperatingActivities'] },
  { conceptKey: 'cf.borrowings.proceeds', statement: 'CF', label: 'Proceeds from borrowings', parentKey: 'cf.financing', ordinal: 60, tags: ['ProceedsFromBorrowingsClassifiedAsFinancingActivities'] },
  { conceptKey: 'cf.borrowings.repaid', statement: 'CF', label: 'Repayment of borrowings', parentKey: 'cf.financing', sign: -1, ordinal: 61, tags: ['RepaymentsOfBorrowingsClassifiedAsFinancingActivities'] },
  { conceptKey: 'cf.lease-payments', statement: 'CF', label: 'Payment of lease liabilities', parentKey: 'cf.financing', sign: -1, ordinal: 62, tags: ['PaymentsOfLeaseLiabilitiesClassifiedAsFinancingActivities'] },
  { conceptKey: 'cf.dividends-paid', statement: 'CF', label: 'Dividends paid', parentKey: 'cf.financing', sign: -1, ordinal: 63, tags: ['DividendsPaidClassifiedAsFinancingActivities'] },
  { conceptKey: 'cf.ppe.proceeds', statement: 'CF', label: 'Proceeds from sale of property, plant and equipment', parentKey: 'cf.investing', ordinal: 41, tags: ['ProceedsFromSalesOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'] },
  { conceptKey: 'cf.interest-received', statement: 'CF', label: 'Interest received', parentKey: 'cf.investing', ordinal: 42, tags: ['InterestReceivedClassifiedAsInvestingActivities'] },

  // ── Per-share and comprehensive-income detail ────────────────────────────
  { conceptKey: 'pl.eps.basic.continuing', statement: 'PL', label: 'Basic EPS (continuing operations)', ordinal: 231, tags: ['BasicEarningsLossPerShareFromContinuingOperations'] },
  { conceptKey: 'pl.eps.diluted.continuing', statement: 'PL', label: 'Diluted EPS (continuing operations)', ordinal: 241, tags: ['DilutedEarningsLossPerShareFromContinuingOperations'] },
  { conceptKey: 'pl.eps.basic.discontinued', statement: 'PL', label: 'Basic EPS (discontinued operations)', ordinal: 232, tags: ['BasicEarningsLossPerShareFromDiscontinuedOperations'] },
  { conceptKey: 'pl.eps.diluted.discontinued', statement: 'PL', label: 'Diluted EPS (discontinued operations)', ordinal: 242, tags: ['DilutedEarningsLossPerShareFromDiscontinuedOperations'] },
  { conceptKey: 'pl.discontinued.pbt', statement: 'PL', label: 'Profit from discontinued operations before tax', ordinal: 188, tags: ['ProfitLossFromDiscontinuedOperationsBeforeTax'] },
  { conceptKey: 'pl.discontinued.tax', statement: 'PL', label: 'Tax on discontinued operations', sign: -1, ordinal: 189, tags: ['TaxExpenseOfDiscontinuedOperations'] },
  { conceptKey: 'pl.oci.not-reclassified', statement: 'PL', label: 'OCI — items not reclassified to P&L', parentKey: 'pl.oci', ordinal: 211, tags: ['AmountOfItemThatWillNotBeReclassifiedToProfitAndLoss'] },
  { conceptKey: 'pl.oci.not-reclassified.tax', statement: 'PL', label: 'Tax on items not reclassified', parentKey: 'pl.oci', sign: -1, ordinal: 212, tags: ['IncomeTaxRelatingToItmesThatWillNotBeReclassifiedToProfitOrLoss'] },
  { conceptKey: 'pl.oci.reclassified', statement: 'PL', label: 'OCI — items to be reclassified to P&L', parentKey: 'pl.oci', ordinal: 213, tags: ['AmountOfItemThatWillBeReclassifiedToProfitAndLoss'] },
  { conceptKey: 'pl.oci.reclassified.tax', statement: 'PL', label: 'Tax on items to be reclassified', parentKey: 'pl.oci', sign: -1, ordinal: 214, tags: ['IncomeTaxRelatingToItmesThatWillBeReclassifiedToProfitOrLoss'] },
  { conceptKey: 'pl.comprehensive.owners', statement: 'PL', label: 'Comprehensive income attributable to owners', ordinal: 221, tags: ['ComprehensiveIncomeForThePeriodAttributableToOwnersOfParent'] },
  { conceptKey: 'pl.comprehensive.minorities', statement: 'PL', label: 'Comprehensive income attributable to non-controlling interests', ordinal: 222, tags: ['ComprehensiveIncomeForThePeriodAttributableToOwnersOfParentNonControllingInterests'] },
  { conceptKey: 'pl.regulatory-deferral', statement: 'PL', label: 'Net movement in regulatory deferral account balances', ordinal: 178, tags: ['NetMovementInRegulatoryDeferralAccountBalancesRelatedToProfitOrLossAndTheRelatedDeferredTaxMovement'] },

  // ── Ratios the filer computes itself ─────────────────────────────────────
  // Kept as filed rather than recomputed: these are the company's own numbers,
  // and a divergence between theirs and ours is a signal worth being able to see.
  { conceptKey: 'ratio.debt-equity', statement: 'PL', label: 'Debt / equity (as filed)', ordinal: 300, tags: ['DebtEquityRatio'] },
  { conceptKey: 'ratio.debt-service-coverage', statement: 'PL', label: 'Debt service coverage (as filed)', ordinal: 301, tags: ['DebtServiceCoverageRatio'] },
  { conceptKey: 'ratio.interest-service-coverage', statement: 'PL', label: 'Interest service coverage (as filed)', ordinal: 302, tags: ['InterestServiceCoverageRatio'] },
];

/**
 * Tags that are DISAGGREGATIONS of lines already in the statement.
 *
 * Segment figures are the whole problem here. In a quarterly filing they sit in
 * dimensioned contexts and the parser drops them automatically. In an ANNUAL
 * filing — verified 2026-08-19 on RELIANCE — several appear in the plain `OneD`
 * context with no dimension at all, so nothing structural distinguishes
 * `SegmentRevenue` from `RevenueFromOperations`.
 *
 * Mapping `SegmentRevenue` to revenue would double-count; storing it unmapped
 * inside the P&L leaves a number in the statement that looks like a company
 * total and is one segment's. Neither is acceptable, so these are excluded from
 * statements entirely and counted instead. Segments deserve their own model
 * (the plan's Quarters tab calls for segment trends); until that exists, the
 * honest state is "not stored" rather than "stored somewhere misleading". The
 * source document is hashed and re-fetchable, so nothing is unrecoverable.
 */
export const EXCLUDED_TAGS = new Set([
  'SegmentRevenue',
  'SegmentRevenueFromOperations',
  'InterSegmentRevenue',
  'SegmentProfitLossBeforeTaxAndFinanceCosts',
  'SegmentProfitBeforeTax',
  'SegmentFinanceCosts',
  'SegmentAssets',
  'SegmentLiabilities',
  'OtherUnallocableExpenditureNetOffUnAllocableIncome',
]);

/**
 * Which statement an UNMAPPED tag belongs to.
 *
 * Without this every unrecognised tag defaulted to the P&L, which put ~40
 * cash-flow lines per annual filing — `ProceedsFromBorrowings...`,
 * `AdjustmentsForDepreciation...`, every `...ClassifiedAsInvestingActivities` —
 * inside the profit and loss statement. They carried no concept key so no
 * subtotal was corrupted, but they were in the wrong statement, and the moment
 * a mapping was added for one it would have been filed there for real.
 *
 * Pattern-based because the Ind-AS taxonomy names cash-flow concepts
 * systematically: the activity classification is in the tag itself.
 */
export function inferStatement(tag: string): 'PL' | 'BS' | 'CF' {
  if (
    /ClassifiedAs(Operating|Investing|Financing)Activities$/.test(tag) ||
    /^CashFlows/.test(tag) ||
    /^AdjustmentsFor/.test(tag) ||
    /^OtherAdjustments/.test(tag) ||
    /CashAndCashEquivalents/.test(tag) ||
    /^ProceedsFrom/.test(tag) ||
    /^PaymentsOf/.test(tag) ||
    /^PaymentsTo/.test(tag) ||
    /^PurchaseOf/.test(tag) ||
    /^CashReceiptsFrom/.test(tag) ||
    /^CashPayments/.test(tag) ||
    /^DividendsReceivedClassified/.test(tag) ||
    /^InterestPaidClassified/.test(tag) ||
    /^InterestReceivedClassified/.test(tag) ||
    /^IncomeTaxesPaid/.test(tag)
  ) {
    return 'CF';
  }
  if (/^(Assets|Liabilities|Equity|EquityAndLiabilities|Noncurrent|Current)/.test(tag)) return 'BS';
  return 'PL';
}

/** Which statement a tag belongs to — used to split one document into statements. */
export const TAG_TO_STATEMENT: Map<string, 'PL' | 'BS' | 'CF'> = new Map(
  CONCEPTS.flatMap((c) => c.tags.map((t) => [t, c.statement] as [string, 'PL' | 'BS' | 'CF'])),
);

export const TAG_TO_CONCEPT: Map<string, string> = new Map(
  CONCEPTS.flatMap((c) => c.tags.map((t) => [t, c.conceptKey] as [string, string])),
);
