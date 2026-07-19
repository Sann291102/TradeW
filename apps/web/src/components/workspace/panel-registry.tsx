import dynamic from 'next/dynamic';
import type { ComponentType, SVGProps } from 'react';
import { Panel } from '@tradew/ui';
import type { PanelKind } from '@/lib/store/workspaceStore';
import type { DockPanelContentProps } from '../terminal/panels/types';
import { WatchlistPanel } from '../terminal/panels/WatchlistPanel';
import { OrderTicketPanel } from '../terminal/panels/OrderTicketPanel';
import { DepthPanel } from '../terminal/panels/DepthPanel';
import { BlotterPanel } from '../terminal/panels/BlotterPanel';
import { SentinelPanel } from '../terminal/panels/SentinelPanel';
import { NewsPanel } from '../terminal/panels/NewsPanel';
import { PortfolioMiniPanel } from '../terminal/panels/PortfolioMiniPanel';
import { LearningMiniPanel } from '../terminal/panels/LearningMiniPanel';
import { ResearchMiniPanel } from '../terminal/panels/ResearchMiniPanel';
import {
  TradeIcon,
  MarketsIcon,
  PortfolioIcon,
  SentinelIcon,
  KnowledgeIcon,
  LearningIcon,
  ResearchIcon,
} from '../shell/icons';

/** Lazy-loaded heavy panels (performance brief: lazy-load Chart/Option Chain). */
const ChartPanel = dynamic(() => import('../terminal/panels/ChartPanel'), {
  ssr: false,
  loading: () => <Panel title="Chart" loading className="min-h-[220px]" />,
});
const OptionChainPanel = dynamic(() => import('../terminal/panels/OptionChainPanel'), {
  ssr: false,
  loading: () => <Panel title="Option Chain" loading />,
});

export interface PanelRegistryEntry {
  title: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  Component: ComponentType<DockPanelContentProps>;
}

/**
 * The dockable-panel catalog — every PanelKind the workspace store knows about
 * maps to a title/icon (for the Command Palette, Closed-Panels menu, etc.) and
 * the actual content component the dock renders. Adding a new dockable panel
 * kind means adding one row here plus a PanelKind union member — nothing else
 * in WorkspaceDock/DockSlot needs to change.
 */
export const PANEL_REGISTRY: Record<PanelKind, PanelRegistryEntry> = {
  watchlist: { title: 'Watchlist', icon: MarketsIcon, Component: WatchlistPanel },
  chart: { title: 'Chart', icon: TradeIcon, Component: ChartPanel },
  blotter: { title: 'Blotter', icon: PortfolioIcon, Component: BlotterPanel },
  optionChain: { title: 'Option Chain', icon: MarketsIcon, Component: OptionChainPanel },
  orderTicket: { title: 'Order Ticket', icon: TradeIcon, Component: OrderTicketPanel },
  depth: { title: 'Market Depth', icon: MarketsIcon, Component: DepthPanel },
  sentinel: { title: 'Sentinel', icon: SentinelIcon, Component: SentinelPanel },
  news: { title: 'News', icon: KnowledgeIcon, Component: NewsPanel },
  portfolio: { title: 'Portfolio', icon: PortfolioIcon, Component: PortfolioMiniPanel },
  learning: { title: 'Learning', icon: LearningIcon, Component: LearningMiniPanel },
  research: { title: 'Research', icon: ResearchIcon, Component: ResearchMiniPanel },
};
