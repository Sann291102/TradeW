'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, AnimatedNumber, EmptyState, Skeleton, cn } from '@tradew/ui';
import { fetchPortfolio, isSignedIn, type PortfolioSummary as PortfolioSummaryDto } from '@/lib/oms';
import { inr, sign } from '@/lib/format';

const POLL_MS = 5_000;

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
 * off it. Same real fetch + 5s poll pattern as that page, condensed to a
 * summary card.
 */
export function PortfolioSummary() {
  const [summary, setSummary] = useState<PortfolioSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = useSignedIn();

  const load = useCallback(async () => {
    setSummary(await fetchPortfolio());
    setError(null);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        await load();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not reach the trading backend');
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [signedIn, load]);

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

/** `isSignedIn` reads localStorage, unavailable during SSR — same
 *  hydration-safety pattern as `PortfolioClient.tsx`'s local hook. */
function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(isSignedIn()), []);
  return signedIn;
}
