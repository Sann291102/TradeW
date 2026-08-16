'use client';

import { useState } from 'react';
import { Card, EmptyState } from '@tradew/ui';

import {
  useHoldings,
  usePortfolioSummary,
  usePositions,
  useSignedIn,
  useInvalidateTradingData,
} from '@/lib/query/usePortfolio';
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
 * Summary + Positions + Holdings are read here at the top level and passed
 * down, since Overview needs Positions/Holdings-derived totals
 * (PortfolioService.summary already does that server-side) and Positions/
 * Holdings need their own live prices regardless of which section is
 * active. Orders/Trade History/Performance read their own data inside their
 * section (different cadence, different filters).
 *
 * The 5s cadence, the retry policy and the pause-when-hidden behaviour now
 * come from the shared cache (lib/query/usePortfolio) instead of a private
 * `setTimeout` chain here. Concretely: the dashboard's PortfolioSummary card
 * and this page no longer both fetch `/sim/portfolio`, and navigating away and
 * back paints from cache instead of from nothing.
 */
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
  const signedIn = useSignedIn();

  const summaryQuery = usePortfolioSummary(signedIn);
  const positionsQuery = usePositions(signedIn);
  const holdingsQuery = useHoldings(signedIn);
  const load = useInvalidateTradingData();

  const summary = summaryQuery.data ?? null;
  const positions = positionsQuery.data ?? null;
  const holdings = holdingsQuery.data ?? null;

  // Report a failure only while there is genuinely nothing to show. A poll
  // that fails against numbers already on screen is transient by construction
  // — the retry is scheduled, and the last-known figures are still the truest
  // thing available. Banner-on-every-blip was what made a two-second outage
  // look like a broken account.
  const failed = [summaryQuery, positionsQuery, holdingsQuery].find((q) => q.isError && !q.data);
  const error = failed
    ? failed.error instanceof Error
      ? failed.error.message
      : 'Could not reach the trading backend'
    : null;

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
      <PortfolioSubNav active={section} onChange={setSection} />

      <div className="min-w-0">
        {error && (
          <div role="alert" className="mb-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
            <p>{error}</p>
            <button
              type="button"
              onClick={load}
              className="mt-1.5 font-semibold underline underline-offset-2 hover:no-underline"
            >
              Try again
            </button>
          </div>
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
  );
}
