'use client';

import { cn } from '@tradew/ui';
import type { ReconciliationCheck } from '@/lib/research/types';
import { statementValue } from '@/lib/research/format';

/**
 * The balance-sheet identity check, shown beside the balance sheet.
 *
 * `Assets = Liabilities + Equity` holds in a filing. It does not always hold in
 * a vendor's REPRESENTATION of one. The brief's instruction — and the right
 * engineering call — is to display the discrepancy rather than adjust a value to
 * make it disappear, so this banner has three states and none of them is silent:
 *
 *   · balanced      — reassurance, quietly
 *   · not balanced  — the difference, in currency and in basis points
 *   · not checkable — which side the provider did not publish
 *
 * A page that always balances is either always right or hiding something, and
 * from the outside those look the same.
 */
export function ReconciliationBanner({ check }: { check: ReconciliationCheck }) {
  if (check.reason) {
    return (
      <Banner tone="neutral">
        <strong className="font-semibold">Balance-sheet check could not be performed.</strong>{' '}
        {check.reason}. The figures above are shown exactly as the provider published them.
      </Banner>
    );
  }

  if (check.balanced) {
    return (
      <Banner tone="ok">
        <strong className="font-semibold">Balance sheet reconciles.</strong> Total assets equal total liabilities plus
        equity for the period ending {check.periodEnd}
        {check.differenceBps !== null && check.differenceBps > 0
          ? ` (within ${check.differenceBps.toFixed(1)}bp of rounding)`
          : ' exactly'}
        .
      </Banner>
    );
  }

  if (check.difference === null) {
    // Unreachable through `reconcileBalanceSheet`, which sets `reason` whenever
    // it cannot compute a difference — but asserted here rather than papered
    // over with `?? 0`, which would have rendered "does not reconcile by 0".
    return (
      <Banner tone="neutral">
        <strong className="font-semibold">Balance-sheet check is incomplete.</strong> The identity could not be
        evaluated for the period ending {check.periodEnd}.
      </Banner>
    );
  }

  return (
    <Banner tone="warn">
      <strong className="font-semibold">Balance sheet does not reconcile.</strong> For the period ending{' '}
      {check.periodEnd}, total assets minus (total liabilities + equity) is{' '}
      <span className="font-mono font-bold">
        {statementValue(check.difference, check.currency)} {check.currency}
      </span>
      {check.differenceBps !== null && <> — {check.differenceBps.toFixed(1)}bp of total assets</>}. TradeW does not
      adjust reported figures to close a gap; every number above is the provider&apos;s own, and the difference is
      shown so you can judge whether the data is fit for your purpose.
    </Banner>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'warn' | 'neutral'; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={cn(
        'rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed',
        tone === 'ok' && 'border-up/40 bg-up-bg text-text',
        tone === 'warn' && 'border-amber/50 bg-amber-bg text-text',
        tone === 'neutral' && 'border-border2 bg-bg/50 text-muted',
      )}
    >
      {children}
    </p>
  );
}
