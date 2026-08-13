'use client';

import type { ReactNode } from 'react';
import type { DashboardModel } from '@/lib/sentinel/dashboardModel';
import { StatusCards } from './StatusCards';
import { LiveMarketOverview } from './LiveMarketOverview';
import { ObservationCard } from './ObservationCard';
import { RiskRadar } from './RiskRadar';
import { EmotionMirror } from './EmotionMirror';
import { SessionTimeline } from './SessionTimeline';
import { QuickActions } from './QuickActions';
import { SessionStats } from './SessionStats';

/**
 * The Sentinel dashboard composition — the reference-design layout, wired
 * entirely to the real `/observe` model. Order and grouping mirror the
 * reference: status-card row, then a three-column band (live market · single
 * observation · risk radar + emotion), then a wide timeline beside quick
 * actions.
 */
export function SentinelDashboard({
  model,
  symbol,
  marketName,
  greeting,
  statusLine,
  controls,
  sessionStats,
  strategyWorkspace,
}: {
  model: DashboardModel;
  symbol: string;
  marketName: string;
  greeting: string;
  statusLine: ReactNode;
  controls: ReactNode;
  sessionStats: { signalsTriggered: number; tradesToday: number | null; flaggedEvents: number | null };
  /**
   * The user-authored strategy/watch surface (services/sentinel-py). Passed in
   * rather than imported so this composition stays a pure layout of the
   * `/observe` model and the two Sentinel services do not become entangled
   * here — the page owns which surfaces exist.
   */
  strategyWorkspace?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {/* greeting header */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-extrabold tracking-tightTrack text-text sm:text-[26px]">{greeting}</h1>
          <p className="mt-1 text-[12.5px] text-muted">Sentinel is observing the markets and your behavior in real-time</p>
          <p className="mt-0.5 text-[11px] text-faint">{statusLine}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">{controls}</div>
      </header>

      <StatusCards model={model} />

      {/* the user's own strategies and watches — the surface for everything
          they authored, above the market read Sentinel produces on its own */}
      {strategyWorkspace}

      {/* main band */}
      <div className="grid grid-cols-12 items-start gap-4">
        <div className="col-span-12 xl:col-span-5">
          <LiveMarketOverview symbol={symbol} marketName={marketName} />
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-4">
          <ObservationCard model={model.observation} />
        </div>
        <div className="col-span-12 space-y-4 md:col-span-6 xl:col-span-3">
          <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[13px] font-bold text-text">Risk Radar</h2>
              <span className="text-[10.5px] text-faint">{model.radar.length} factors</span>
            </div>
            <RiskRadar factors={model.radar} />
          </section>
          <EmotionMirror emotion={model.emotion} />
        </div>
      </div>

      {/* timeline + stats + actions */}
      <div className="grid grid-cols-12 items-start gap-4">
        <div className="col-span-12 xl:col-span-8">
          <SessionTimeline dots={model.timeline} />
        </div>
        <div className="col-span-12 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:col-span-4 xl:grid-cols-1">
          <SessionStats
            observations={model.observationCount}
            signalsTriggered={sessionStats.signalsTriggered}
            tradesToday={sessionStats.tradesToday}
            flaggedEvents={sessionStats.flaggedEvents}
          />
          <QuickActions />
        </div>
      </div>

      <p className="pb-6 text-center text-[11px] text-faint">
        Sentinel observes market context and behavior in parallel. It never executes trades and never gives buy, sell,
        entry, exit or target recommendations.
      </p>
    </div>
  );
}
