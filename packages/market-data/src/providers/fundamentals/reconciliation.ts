/**
 * Balance-sheet reconciliation — show the discrepancy, never close it.
 *
 * The accounting identity `Assets = Liabilities + Equity` holds in a filing. It
 * does not always hold in a VENDOR'S REPRESENTATION of a filing: line items get
 * dropped from a mapping, minority interest lands outside equity, a restatement
 * lands in one statement and not the other.
 *
 * The tempting fix — plug the gap into "other liabilities", or compute equity as
 * assets minus liabilities — produces a page that always balances and sometimes
 * lies. This module does the opposite: it reports the imbalance, in currency and
 * as a share of total assets, and leaves both reported numbers untouched. The UI
 * shows the check next to the statement so a reader can decide whether the data
 * is fit for their purpose.
 *
 * `toleranceBps` exists because vendors round to thousands or lakhs and a
 * rounding residue is not a data-quality problem. It is a tolerance on the
 * COMPARISON, never an adjustment to the values.
 */

import { BALANCE_METRICS, type StatementPeriod } from './fundamentals.contract';

export interface ReconciliationCheck {
  periodEnd: string;
  /** True when both sides were present and agreed within tolerance. */
  balanced: boolean;
  /** Null when a required line was not reported — 'unknown', not 'failed'. */
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  /** Assets − (Liabilities + Equity). Positive = assets exceed the other side. */
  difference: number | null;
  /** |difference| ÷ totalAssets, in basis points. */
  differenceBps: number | null;
  currency: string;
  /** Why the check could not be performed, when it could not be. */
  reason?: string;
}

/**
 * 50bp — half a percent of total assets. Wide enough to absorb the unit
 * rounding vendors apply, narrow enough that a genuinely missing line item
 * (which is typically percentage points, not fractions of one) still trips it.
 */
export const DEFAULT_TOLERANCE_BPS = 50;

export function reconcileBalanceSheet(
  period: StatementPeriod | undefined,
  toleranceBps: number = DEFAULT_TOLERANCE_BPS,
): ReconciliationCheck | null {
  if (!period) return null;

  const assets = period.facts[BALANCE_METRICS.totalAssets]?.value ?? null;
  const liabilities = period.facts[BALANCE_METRICS.totalLiabilities]?.value ?? null;
  const equity = period.facts[BALANCE_METRICS.totalEquity]?.value ?? null;

  const base: ReconciliationCheck = {
    periodEnd: period.periodEnd,
    balanced: false,
    totalAssets: assets,
    totalLiabilities: liabilities,
    totalEquity: equity,
    difference: null,
    differenceBps: null,
    currency: period.currency,
  };

  const missing: string[] = [];
  if (assets === null) missing.push('total assets');
  if (liabilities === null) missing.push('total liabilities');
  if (equity === null) missing.push("total shareholders' equity");
  if (missing.length > 0) {
    return { ...base, reason: `not reported: ${missing.join(', ')}` };
  }
  if (assets === 0) {
    return { ...base, reason: 'total assets reported as zero — the identity cannot be checked' };
  }

  const difference = assets! - (liabilities! + equity!);
  const differenceBps = Math.abs(difference / assets!) * 10_000;

  return {
    ...base,
    balanced: differenceBps <= toleranceBps,
    difference,
    differenceBps,
  };
}
