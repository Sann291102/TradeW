import { MarketWorkspace } from '@/components/dashboard/MarketWorkspace';

export const metadata = { title: 'Market Workspace — TradeW' };

/**
 * Dashboard route — evolved in place (Phase 1 redesign) from the Milestone 2
 * static grid into the Market Workspace: the landing page / command center
 * answering "what is happening in the market right now" (see
 * docs/product-architecture/MARKET-WORKSPACE.md). Route/path unchanged, per
 * the repo's never-delete rule — only the composition inside it evolved.
 * Server component; `MarketWorkspace` is the 'use client' wrapper that runs
 * the staggered entrance animation.
 */
export default function DashboardPage() {
  return <MarketWorkspace />;
}
