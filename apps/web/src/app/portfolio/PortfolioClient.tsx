'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, EmptyState, Skeleton, StatCard } from '@tradew/ui';
import { inr, sign } from '@/lib/format';
import {
  type HoldingDto,
  type PortfolioSummary,
  type PositionDto,
  fetchHoldings,
  fetchPortfolio,
  fetchPositions,
  isSignedIn,
} from '@/lib/oms';
import { PortfolioSubNav, type PortfolioSection } from '@/components/portfolio/PortfolioSubNav';
import { OverviewSection } from '@/components/portfolio/sections/OverviewSection';
import { HoldingsSection } from '@/components/portfolio/sections/HoldingsSection';
import { PositionsSection } from '@/components/portfolio/sections/PositionsSection';
import { OrdersSection } from '@/components/portfolio/sections/OrdersSection';
import { TradeHistorySection } from '@/components/portfolio/sections/TradeHistorySection';
import { PerformanceSection } from '@/components/portfolio/sections/PerformanceSection';

/**
 * Portfolio workspace — the real paper account, rebuilt into the full
 * broker-page spec: Summary, Holdings, Positions, Orders, Trade History,
 * Performance. Every number comes from the OMS (`services/api/src/sim/*`) —
 * no mock data anywhere on this page. See knowledge/Patterns for the
 * settlement-lifecycle and snapshot-performance design this is built on.
 *
 * Summary + Positions + Holdings are polled (5s) here at the top level and
 * passed down, since Overview needs Positions/Holdings-derived totals
 * (PortfolioService.summary already does that server-side) and Positions/
 * Holdings need their own live prices regardless of which section is
 * active. Orders/Trade History/Performance fetch their own data inside
 * their section (different cadence, different filters) rather than being
 * threaded through this shared poll.
 */
const POLL_MS = 5_000;

const SECTION_TITLES: Record<PortfolioSection, string> = {
  overview: 'Portfolio Summary',
  holdings: 'Holdings',
  positions: 'Positions',
  orders: 'Orders',
  'trade-history': 'Trade History',
  performance: 'Performance',
};

export function PortfolioClient() {
  const [section, setSection] = useState<PortfolioSection>('overview');
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [positions, setPositions] = useState<PositionDto[] | null>(null);
  const [holdings, setHoldings] = useState<HoldingDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = useSignedIn();

  const load = useCallback(async () => {
    const [s, p, h] = await Promise.all([fetchPortfolio(), fetchPositions(), fetchHoldings()]);
    setSummary(s);
    setPositions(p);
    setHoldings(h);
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
      <div className="mx-auto max-w-[1200px] p-4">
        <EmptyState
          title="Sign in to see your paper account"
          description="Your holdings, positions, orders and performance live on your account — there is nothing to show for a signed-out visitor."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatPreview summary={summary} />
      </section>

      <div className="flex flex-col gap-4 lg:flex-row">
        <PortfolioSubNav active={section} onChange={setSection} />

        <div className="min-w-0 flex-1">
          {error && (
            <p role="alert" className="mb-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
              {error}
            </p>
          )}

          <Card title={SECTION_TITLES[section]}>
            {section === 'overview' && <OverviewSection summary={summary} />}
            {section === 'holdings' && <HoldingsSection holdings={holdings} error={error} onChanged={load} />}
            {section === 'positions' && <PositionsSection positions={positions} error={error} onChanged={load} />}
            {section === 'orders' && <OrdersSection />}
            {section === 'trade-history' && <TradeHistorySection />}
            {section === 'performance' && <PerformanceSection />}
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Compact always-visible header stats, independent of which section is
 *  open — the four figures a trader checks first on any broker portfolio
 *  page, per the reference layout. Full seven-tile breakdown lives in the
 *  Overview section itself. */
function StatPreview({ summary }: { summary: PortfolioSummary | null }) {
  if (!summary) {
    return (
      <>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </>
    );
  }
  return (
    <>
      <StatCard label="Current Value" value={inr(summary.currentValue, 2)} />
      <StatCard label="Today's P&L" value={`${sign(summary.dailyPnl)}${inr(Math.abs(summary.dailyPnl), 2)}`} />
      <StatCard label="Overall P&L" value={`${sign(summary.overallPnl)}${inr(Math.abs(summary.overallPnl), 2)}`} />
      <StatCard label="Available Balance" value={inr(summary.availableBalance, 2)} />
    </>
  );
}

/** `isSignedIn` reads localStorage, which does not exist during SSR; reading it
 *  in render would make server and client HTML disagree. Same pattern the order
 *  ticket already uses. */
function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(isSignedIn()), []);
  return signedIn;
}
