'use client';

import { useCallback, useState, type ReactNode } from 'react';
import type { DashboardModel } from '@/lib/sentinel/dashboardModel';
import { useSessionStats } from '@/lib/sentinel/useSessionStats';
import { StatusCards } from './StatusCards';
import { LiveMarketOverview } from './LiveMarketOverview';
import { StrategyTimelineFeed, type WatchObservation } from '../StrategyTimelineFeed';
import { StrategyConditionsPanel } from '../StrategyConditionsPanel';
import { SentinelLiveCharts } from '../SentinelLiveCharts';
import { SentinelChartReading } from '../SentinelChartReading';
import { RiskRadar } from './RiskRadar';
import { EmotionMirror } from './EmotionMirror';
import { MarketContextRail } from './MarketContextRail';
import { SessionTimeline } from './SessionTimeline';
import { QuickActions } from './QuickActions';
import { SessionStats } from './SessionStats';

/** Anchor the conditions panel's Edit control scrolls to. */
const STRATEGY_WORKSPACE_ID = 'your-strategies';

/**
 * The Sentinel dashboard composition — the reference-design layout, wired
 * entirely to real data. Order and grouping mirror the reference:
 *
 *   status cards
 *   your strategies (the sentinel-py authoring surface)
 *   what Sentinel is reading  ← the three charts + the engine's measurements
 *   ─────────────────────────────────────────────────────────────────────────
 *   strategy feed  │  your conditions  │  risk radar
 *   (scrolls)      │                   │  emotion report
 *                  │  session timeline (spans both right columns)
 *   session stats  │  quick actions    │  market context
 *
 * The band below the rule is the reference image, integrated in its own order
 * directly after the reading panel: what Sentinel is looking at, then what it
 * has seen, then what the user asked it to look for, then the session's shape.
 *
 * ── ON "REAL TIME" ─────────────────────────────────────────────────────────
 * Three independent cadences drive this screen, on purpose. `/observe` polls
 * every 45s (radar, emotion, timeline, market context, status cards); the
 * strategy feed and the session-stats aggregate poll `services/sentinel-py`
 * every 10s, because that engine re-sweeps every 15s and tying the user's own
 * watches to the slower observation poll would leave a confirmed setup reading
 * as unconfirmed for most of a minute. Each degrades alone: a dead sentinel-py
 * does not blank the market read, and vice versa.
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
  /**
   * The watch the user has selected in the feed, and what the engine last
   * read off it. Held here because this is the only component that renders
   * both the feed (which owns the selector) and the charts.
   */
  const [observation, setObservation] = useState<WatchObservation | null>(null);

  /** The user's own watch figures, on their own 10s cadence. */
  const { stats, stale: statsStale } = useSessionStats();

  /**
   * The rules are edited where they were written. Scrolling rather than
   * routing keeps the live surface — charts, feed, sweep — mounted and
   * polling; a navigation away and back would restart every one of them.
   */
  const editConditions = useCallback(() => {
    document.getElementById(STRATEGY_WORKSPACE_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
      <div id={STRATEGY_WORKSPACE_ID} className="scroll-mt-4">
        {strategyWorkspace}
      </div>

      {/*
        The standing market read — "what is the market doing", a different
        question from the reading panel's "what is the engine evaluating".
        Above the charts rather than below them so the reference band that
        follows sits directly after the reading panel at every breakpoint,
        with no card wedged between the two.
      */}
      <LiveMarketOverview symbol={symbol} marketName={marketName} />

      {/*
        The charts for whatever watch is selected in the feed below — the
        index the setup lives in, plus BOTH legs of the strike Sentinel is
        reading, so "which side is actually confirming" is one glance.

        Full width and above the band on purpose: three charts need real
        width before the comparison is legible at all, and this is the
        answer to "what is Sentinel looking at?" — it belongs beside the
        user's strategies rather than below the session stats.

        Only rendered once a watch exists. With nothing selected there is no
        instrument under observation, and three ATM charts labelled "what
        Sentinel is reading" would be a claim about an engine that is not
        running.
      */}
      {observation && (
        <SentinelLiveCharts
          symbol={symbol}
          marketName={marketName}
          ceStrike={null}
          peStrike={null}
          focus={observation.focus}
          footer={<SentinelChartReading reading={observation.reading} />}
        />
      )}

      {/*
        ── the reference band ──────────────────────────────────────────────
        Feed on the left spanning both rows, conditions in the middle, risk
        radar above the emotion report on the right, and the session timeline
        filling the width the middle and right columns leave in row two.

        `items-start` is deliberate: without it the grid stretches every cell
        to the tallest row, which pads the emotion report to the height of a
        long feed and leaves a card that is mostly empty space.
      */}
      <div className="grid grid-cols-12 items-start gap-4">
        <div className="col-span-12 xl:col-span-4 xl:row-span-2">
          {/* Replaces the old generic ObservationCard (market-wide analysis +
              model confidence bar), which said nothing about whether the
              user's OWN strategy was working. The focus panel is suppressed
              here — its conditions half is the panel immediately to the right. */}
          <StrategyTimelineFeed onObservationChange={setObservation} showFocusPanel={false} />
        </div>

        <div className="col-span-12 md:col-span-6 xl:col-span-4">
          <StrategyConditionsPanel timeline={observation?.timeline ?? null} onEdit={editConditions} />
        </div>

        <div className="col-span-12 space-y-4 md:col-span-6 xl:col-span-4">
          <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[13px] font-bold text-text">Risk Radar</h2>
              <span className="text-[10.5px] text-faint">
                {model.radar.length} factors · {model.marketActive ? 'real-time' : 'last read'}
              </span>
            </div>
            <RiskRadar factors={model.radar} />
          </section>
          <EmotionMirror emotion={model.emotion} />
        </div>

        <div className="col-span-12 xl:col-span-8">
          <SessionTimeline dots={model.timeline} />
        </div>
      </div>

      {/* stats · actions · context */}
      <div className="grid grid-cols-12 items-start gap-4">
        <div className="col-span-12 xl:col-span-5">
          <SessionStats
            observations={model.observationCount}
            signalsTriggered={sessionStats.signalsTriggered}
            tradesToday={sessionStats.tradesToday}
            flaggedEvents={sessionStats.flaggedEvents}
            stats={stats}
            stale={statsStale}
          />
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-4">
          <QuickActions />
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-3">
          <MarketContextRail
            tags={model.marketContext.tags}
            dimensions={model.marketContext.dimensions}
            live={model.marketActive}
          />
        </div>
      </div>

      <p className="pb-6 text-center text-[11px] text-faint">
        Sentinel observes market context and behavior in parallel. It never executes trades and never gives buy, sell,
        entry, exit or target recommendations.
      </p>
    </div>
  );
}
