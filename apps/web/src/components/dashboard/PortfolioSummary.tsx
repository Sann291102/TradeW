'use client';

import Link from 'next/link';
import { Card, AnimatedNumber, EmptyState, Skeleton, cn } from '@tradew/ui';
import { usePortfolioSummary, useSignedIn } from '@/lib/query/usePortfolio';
import { inr, sign } from '@/lib/format';

function Metric({ label, value, tone, signed }: { label: string; value: number; tone?: 'up' | 'down'; signed?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-faint">{label}</div>
      <AnimatedNumber
        value={value}
        countUpOnMount
        format={(n) => `${signed ? sign(n) : ''}${inr(n)}`}
        className={cn(
          'block px-0 text-base font-bold',
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text',
        )}
      />
    </div>
  );
}

/**
 * PortfolioSummary — the "My Portfolio" dashboard card.
 *
 * Was rendering `PORTFOLIO_SUMMARY`, a hardcoded object from
 * lib/mock/market.ts, even though `/sim/portfolio` was already live and the
 * real Portfolio page (`app/portfolio/PortfolioClient.tsx`) had already moved
 * off it. Condensed to a summary card.
 *
 * Reads the SAME cached `/sim/portfolio` query as the Portfolio page rather
 * than running its own 5s timer — with both mounted that endpoint was being
 * fetched twice per tick for identical data.
 */
export function PortfolioSummary() {
  const signedIn = useSignedIn();
  const { data, isError, error: queryError } = usePortfolioSummary(signedIn);

  const summary = data ?? null;
  // Stale numbers beat an error banner: a failed poll against figures already
  // on screen is transient, and the retry is already scheduled.
  const error =
    isError && !data
      ? queryError instanceof Error
        ? queryError.message
        : 'Could not reach the trading backend'
      : null;

  if (!signedIn) {
    return (
      <Card title="My Portfolio" subtitle="· paper account">
        <EmptyState
          title="Sign in to see your paper account"
          description="Investment, P&L and margin appear here once you're signed in."
          action={
            <Link href="/login" className="text-xs font-bold text-teal hover:underline">
              Sign in →
            </Link>
          }
        />
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="My Portfolio" subtitle="· paper account">
        <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">{error}</p>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card title="My Portfolio" subtitle="· paper account">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  const overallTone = summary.overallPnl >= 0 ? 'up' : 'down';
  const todayTone = summary.dailyPnl >= 0 ? 'up' : 'down';

  return (
    <Link href="/portfolio" className="block">
      <Card title="My Portfolio" subtitle="· paper account" elevation={2} className="transition-colors hover:border-border2">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Investment" value={summary.investedAmount} />
          <Metric label="Current value" value={summary.currentValue} />
          <Metric label="Overall P&L" value={summary.overallPnl} tone={overallTone} signed />
          <Metric label="Today's P&L" value={summary.dailyPnl} tone={todayTone} signed />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-xs text-muted">
          <span>Open positions: <b className="text-text">{summary.openPositionsCount}</b></span>
          <span>Margin available: <b className="font-mono tabular-nums text-text">{inr(summary.availableMargin)}</b></span>
          <span>Margin used: <b className="font-mono tabular-nums text-text">{inr(summary.marginUsed)}</b></span>
          <span>Equity: <b className="font-mono tabular-nums text-text">{inr(summary.netWorth)}</b></span>
        </div>
      </Card>
    </Link>
  );
}
