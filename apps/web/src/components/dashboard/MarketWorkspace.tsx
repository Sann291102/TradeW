'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { staggerContainerSlow, cardEntrance, withReducedMotion } from '@tradew/ui';
import { IndexOverview } from './IndexOverview';
import { PortfolioSummary } from './PortfolioSummary';
import { MarketMovers } from './MarketMovers';
import { SectorHeatmap } from './SectorHeatmap';
import { TrendingStocks } from './TrendingStocks';
import { WatchlistWidget } from './WatchlistWidget';
import { GlobalMarkets } from './GlobalMarkets';
import { CommodityMarkets } from './CommodityMarkets';
import { RiskAlerts } from './RiskAlerts';
import { EconomicCalendar } from './EconomicCalendar';
import { SentinelBriefing } from './SentinelBriefing';
import { QuickLinks } from './QuickLinks';

/**
 * MarketWorkspace — the Market Workspace landing page (evolved in place from
 * the Milestone 2 dashboard, per the user's brief: "what is happening in the
 * market right now"). Client wrapper so the staggered section entrance can
 * run; `dashboard/page.tsx` stays a server component composing this.
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
      <div>
        <h1 className="text-lg font-bold text-text">Market Workspace</h1>
        <p className="text-xs text-muted">What&apos;s happening in the market right now.</p>
      </div>

      <motion.div variants={item}>
        <IndexOverview />
      </motion.div>

      <motion.div variants={item} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <GlobalMarkets />
          <CommodityMarkets />
        </div>
        <RiskAlerts />
      </motion.div>

      <motion.div variants={item} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MarketMovers />
        <div className="space-y-4">
          <SectorHeatmap />
          <TrendingStocks />
        </div>
        <WatchlistWidget />
      </motion.div>

      <motion.div variants={item} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SentinelBriefing />
        </div>
        <PortfolioSummary />
      </motion.div>

      {/* Market News moved to its own route (/news, "Market News" in the
          sidebar). Here it was capped at six items and sharing a row; there it
          carries the full live feed. EconomicCalendar keeps the row. */}
      <motion.div variants={item}>
        <EconomicCalendar />
      </motion.div>

      <motion.div variants={item}>
        <QuickLinks />
      </motion.div>
    </motion.div>
  );
}
