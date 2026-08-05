'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { staggerContainerSlow, cardEntrance, withReducedMotion } from '@tradew/ui';
import { DashboardHero } from './DashboardHero';
import { IndexOverview } from './IndexOverview';
import { MarketOverview } from './MarketOverview';
import { MarketMovers } from './MarketMovers';
import { SectorHeatmap } from './SectorHeatmap';
import { TodaysTrades } from './TodaysTrades';
import { WatchlistWidget } from './WatchlistWidget';
import { RiskAlerts } from './RiskAlerts';
import { MarketNews } from './MarketNews';

/**
 * MarketWorkspace — the Market Workspace landing page, matched 1:1 to the
 * reference layout: hero greeting + live NIFTY card, the 5-index strip, a
 * Market Overview chart paired with Watchlist + Market Alerts (both columns
 * end together), then a Market Movers/Sector Heatmap/Today's Trades row
 * paired with Market News.
 *
 * `GlobalMarkets`, `CommodityMarkets`, `TrendingStocks`, `EconomicCalendar`,
 * `SentinelBriefing`, `QuickLinks` and the fuller `PortfolioSummary` card
 * previously lived below this in a "More on your workspace" section. None of
 * it is in the reference, and pairing it against unrelated content kept
 * producing the same class of dead-space gap this file already fought once
 * (see the comment below on the two paired rows). Per the user's direction
 * it's archived out of this page rather than fought into a forced balance —
 * the component files themselves are untouched in `components/dashboard/`
 * and `components/portfolio/`, so re-adding any of them here later is a
 * one-line import + JSX addition, not lost work.
 */
export function MarketWorkspace() {
  const reduce = useReducedMotion();
  const container = withReducedMotion(staggerContainerSlow, !!reduce);
  const item = withReducedMotion(cardEntrance, !!reduce);

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={container}
      className="mx-auto max-w-[1440px] space-y-4 p-4"
    >
      <motion.div variants={item}>
        <DashboardHero />
      </motion.div>

      <motion.div variants={item}>
        <IndexOverview />
      </motion.div>

      {/* Row 1 — Market Overview paired with ONLY Watchlist + Market Alerts.
          NOT items-start: the two columns stretch to match each other, and
          MarketOverview measures its own stretched cell height at runtime
          (ResizeObserver, see MarketOverview.tsx) to size its chart exactly
          to it. A hardcoded pixel height here previously only matched at one
          specific viewport width — Watchlist/Alerts row text wraps
          differently at other widths, so a fixed chart height drifted out of
          alignment with them. */}
      <motion.div variants={item} className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <MarketOverview />
        </div>
        <div className="space-y-4">
          <WatchlistWidget />
          <RiskAlerts />
        </div>
      </motion.div>

      {/* Row 2 — Market Movers/Sector Heatmap/Today's Trades paired with
          Market News, matching the reference's second row exactly (News
          sits beside this row, not stacked under Market Alerts).
          The inner three (Movers/Heatmap/Trades) deliberately do NOT use
          items-start: their natural heights are already close, so the
          default stretch gives them even, aligned bottoms instead of a
          ragged row — unlike the chart-vs-rail pairing above, where
          stretching would have opened a large dead-space gap. */}
      <motion.div variants={item} className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:col-span-2">
          <MarketMovers />
          <SectorHeatmap />
          <TodaysTrades />
        </div>
        <MarketNews />
      </motion.div>
    </motion.div>
  );
}
