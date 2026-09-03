import { describe, expect, it } from 'vitest';
import { CONCEPTS, EXCLUDED_TAGS, inferStatement, TAG_TO_CONCEPT, TAG_TO_STATEMENT } from './concept-seed';

/**
 * The chart of accounts is reference data, but two things in here are logic:
 * where an UNMAPPED tag is filed, and which tags are excluded outright. Both
 * were written in response to defects found by reading real ingested output,
 * so both are pinned.
 */

describe('inferStatement', () => {
  it('routes cash-flow tags to CF', () => {
    // THE DEFECT THIS FIXES. Before it, every unmapped tag defaulted to the
    // P&L, which filed ~40 cash-flow lines per annual filing inside the profit
    // and loss statement. They carried no concept key so no subtotal broke —
    // but they were in the wrong statement, and mapping one would have made it
    // permanent.
    const cashFlowTags = [
      'ProceedsFromBorrowingsClassifiedAsFinancingActivities',
      'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
      'InterestReceivedClassifiedAsInvestingActivities',
      'AdjustmentsForDepreciationAndAmortisationExpense',
      'AdjustmentsForIncreaseDecreaseInTradePayablesCurrent',
      'CashFlowsFromUsedInOperatingActivities',
      'OtherAdjustmentsForNoncashItems',
      'PaymentsOfLeaseLiabilitiesClassifiedAsFinancingActivities',
      'IncomeTaxesPaidRefundClassifiedAsOperatingActivities',
      'EffectOfExchangeRateChangesOnCashAndCashEquivalents',
      'CashReceiptsFromRepaymentOfAdvancesAndLoansMadeToOtherPartiesClassifiedAsInvestingActivities',
    ];
    for (const tag of cashFlowTags) {
      expect(inferStatement(tag), tag).toBe('CF');
    }
  });

  it('routes balance-sheet tags to BS', () => {
    for (const tag of ['Assets', 'Liabilities', 'Equity', 'CurrentAssets', 'NoncurrentLiabilities', 'EquityAndLiabilities']) {
      expect(inferStatement(tag), tag).toBe('BS');
    }
  });

  it('leaves genuine P&L tags in PL', () => {
    for (const tag of ['RevenueFromOperations', 'EmployeeBenefitExpense', 'ProfitBeforeTax', 'OtherIncome']) {
      expect(inferStatement(tag), tag).toBe('PL');
    }
  });

  it('does not mistake an income-statement expense for a cash payment', () => {
    // `PurchasesOfStockInTrade` is a P&L line and starts with "Purchases", not
    // "PurchaseOf" — the distinction the CF pattern turns on. Worth pinning
    // because getting it wrong moves cost of goods into the cash-flow statement.
    expect(inferStatement('PurchasesOfStockInTrade')).toBe('PL');
  });
});

describe('EXCLUDED_TAGS', () => {
  it('excludes segment disaggregations', () => {
    // In a QUARTERLY filing these sit in dimensioned contexts and the parser
    // drops them structurally. In an ANNUAL filing several appear in the plain
    // `OneD` context with no dimension at all, so nothing distinguishes
    // SegmentRevenue from RevenueFromOperations except this list. Mapping it
    // would double-count; leaving it unmapped in the P&L leaves a
    // single-segment number that looks like a company total.
    for (const tag of ['SegmentRevenue', 'SegmentAssets', 'InterSegmentRevenue', 'SegmentProfitBeforeTax']) {
      expect(EXCLUDED_TAGS.has(tag), tag).toBe(true);
    }
  });

  it('never excludes a tag that is also mapped to a concept', () => {
    // An excluded tag with a mapping would be silently unreachable — the
    // mapping would look present and never apply.
    for (const tag of EXCLUDED_TAGS) {
      expect(TAG_TO_CONCEPT.has(tag), `${tag} is both excluded and mapped`).toBe(false);
    }
  });
});

describe('concept catalogue invariants', () => {
  it('has no duplicate concept keys', () => {
    const keys = CONCEPTS.map((c) => c.conceptKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps every tag to exactly one concept', () => {
    // Two concepts claiming one tag would make ingestion order decide which
    // line a filed number lands on.
    const seen = new Map<string, string>();
    for (const c of CONCEPTS) {
      for (const tag of c.tags) {
        expect(seen.has(tag), `${tag} claimed by ${seen.get(tag)} and ${c.conceptKey}`).toBe(false);
        seen.set(tag, c.conceptKey);
      }
    }
    expect(TAG_TO_CONCEPT.size).toBe(seen.size);
  });

  it('gives every tag the statement of the concept that owns it', () => {
    for (const c of CONCEPTS) {
      for (const tag of c.tags) {
        expect(TAG_TO_STATEMENT.get(tag), tag).toBe(c.statement);
      }
    }
  });

  it('points every parentKey at a concept that exists, in the same statement', () => {
    const byKey = new Map(CONCEPTS.map((c) => [c.conceptKey, c]));
    for (const c of CONCEPTS) {
      if (!c.parentKey) continue;
      const parent = byKey.get(c.parentKey);
      expect(parent, `${c.conceptKey} -> missing parent ${c.parentKey}`).toBeDefined();
      // A child in a different statement from its parent would break subtotal
      // checks, which only ever compare within one statement.
      expect(parent!.statement, `${c.conceptKey} parent is in another statement`).toBe(c.statement);
    }
  });

  it('uses only +1 or -1 for sign', () => {
    for (const c of CONCEPTS) {
      expect([1, -1], c.conceptKey).toContain(c.sign ?? 1);
    }
  });

  it('keeps the share-count pair present and in the same statement', () => {
    // Market cap depends on both halves of this pair being ingested together.
    const paid = CONCEPTS.find((c) => c.conceptKey === 'equity.paid-up-capital');
    const face = CONCEPTS.find((c) => c.conceptKey === 'equity.face-value');
    expect(paid).toBeDefined();
    expect(face).toBeDefined();
    expect(paid!.statement).toBe(face!.statement);
  });

  it('keeps the cash-flow bridge concepts distinct', () => {
    // CFO+CFI+CFF equals the change in cash BEFORE exchange differences. If
    // these two collapsed into one concept, the validator would compare the
    // activity totals against the post-FX figure and fail for every company
    // with foreign operations.
    expect(TAG_TO_CONCEPT.get('IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges')).toBe(
      'cf.net-change-before-fx',
    );
    expect(TAG_TO_CONCEPT.get('IncreaseDecreaseInCashAndCashEquivalents')).toBe('cf.net-change');
  });
});
