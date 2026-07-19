import { IndexOverview } from '@/components/dashboard/IndexOverview';
import { PortfolioSummary } from '@/components/dashboard/PortfolioSummary';
import { MarketMovers } from '@/components/dashboard/MarketMovers';
import { SectorHeatmap } from '@/components/dashboard/SectorHeatmap';
import { TrendingStocks } from '@/components/dashboard/TrendingStocks';
import { MarketNews } from '@/components/dashboard/MarketNews';
import { WatchlistWidget } from '@/components/dashboard/WatchlistWidget';

export const metadata = { title: 'Dashboard — TradeW' };

/**
 * Dashboard workspace (Milestone 2, Step 5) — faithful React conversion of the
 * canonical terminal's home page. Each widget is an independent component
 * (components/dashboard/*), composed here into the responsive card grid. Server
 * component; interactive widgets (MarketMovers) opt into 'use client' themselves.
 */
export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-[1440px] space-y-4 p-4">
      <IndexOverview />
      <PortfolioSummary />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MarketMovers />
        <div className="space-y-4">
          <SectorHeatmap />
          <TrendingStocks />
        </div>
        <WatchlistWidget />
      </div>

      <MarketNews />
    </div>
  );
}
