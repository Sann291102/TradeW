'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { DashboardModel } from '@/lib/sentinel/dashboardModel';
import { engineFocusFrom } from '@/lib/sentinel/chartFocus';
import { useSentinelWatch } from '@/lib/sentinel/WatchContext';
import { StatusCards } from './StatusCards';
import { StrategyTimelineFeed, type WatchObservation } from '../StrategyTimelineFeed';
import { StrategyConditionsPanel } from '../StrategyConditionsPanel';
import { SentinelLiveCharts } from '../SentinelLiveCharts';
import { SentinelChartReading } from '../SentinelChartReading';
import { SentinelContractReading } from '../SentinelContractReading';
import { EmotionMirror } from './EmotionMirror';
import { MarketContextRail } from './MarketContextRail';

/** Anchor the conditions panel's Edit control scrolls to. */
const STRATEGY_WORKSPACE_ID = 'your-strategies';

/**
 * The Sentinel dashboard composition — the reference-design layout, wired
 * entirely to real data. Order and grouping mirror the reference:
 *
 *   status cards
 *   your strategies (the sentinel-py authoring surface)
 *   what Sentinel is watching  ← the three charts, ALWAYS rendered
 *   ─────────────────────────────────────────────────────────────────────────
 *   strategy feed  │  your conditions  │  emotion report
 *   (scrolls)      │                   │  market context
 *
 * ── THE CHARTS ARE NOT GATED ON A WATCH ────────────────────────────────────
 * They used to be (`{observation && <SentinelLiveCharts/>}`), on the reasoning
 * that three ATM charts labelled "what Sentinel is reading" claim an engine is
 * running when none is. The reasoning was sound; the implementation was the
 * wrong lever. `SentinelLiveCharts` ALREADY distinguishes the two cases by
 * itself — with no `focus` it titles itself "Live Charts" and draws the
 * selected market's ATM strikes off its own option-chain poll; with a focus it
 * becomes "What Sentinel is reading", pinned to the watch's strike and to the
 * timeframe the engine actually evaluates. So the honesty requirement was
 * already met inside the component, and the outer gate only ever removed the
 * panel from users who had no watch yet — which is everyone whose sentinel-py
 * is unreachable, the exact case where seeing the market still matters.
 * Pass `focus` and let the component decide; do not re-add the gate.
 *
 * ── NOTHING SITS BETWEEN THE READING PANEL AND THE BAND ────────────────────
 * A `LiveMarketOverview` card (a second candle chart of the same index, with
 * an EMA/RSI/VWAP/MACD strip) used to render here, between the strategy
 * workspace and the charts. Removed 2026-08-16 and archived to
 * `archive/web-sentinel-live-market-overview-2026-08-16.tsx.txt`: it drew the
 * SAME instrument the reading panel draws immediately below it, so the screen
 * asked "what is Sentinel reading?" twice and answered it differently — one
 * card on the user's chosen timeframe tab, the other on the bar the engine
 * actually evaluates. The reading panel is the one tied to the engine, so it
 * is the one that stayed. Do not reintroduce a standing index chart above it.
 *
 * ── ON "REAL TIME" ─────────────────────────────────────────────────────────
 * Two independent cadences drive this screen, on purpose. `/observe` polls
 * every 45s (emotion, market context, status cards); the strategy feed polls
 * `services/sentinel-py` every 10s, because that engine re-sweeps every 15s
 * and tying the user's own watches to the slower observation poll would leave
 * a confirmed setup reading as unconfirmed for most of a minute. Each degrades
 * alone: a dead sentinel-py does not blank the market read, and vice versa.
 */
export function SentinelDashboard({
  model,
  symbol,
  marketName,
  greeting,
  statusLine,
  controls,
  strategyWorkspace,
}: {
  model: DashboardModel;
  symbol: string;
  marketName: string;
  greeting: string;
  statusLine: ReactNode;
  controls: ReactNode;
  /**
   * The user-authored strategy/watch surface (services/sentinel-py). Passed in
   * rather than imported so this composition stays a pure layout of the
   * `/observe` model and the two Sentinel services do not become entangled
   * here — the page owns which surfaces exist.
   */
  strategyWorkspace?: ReactNode;
}) {
  /**
   * The canonical market/strike selection — the same object `WatchCreator`
   * writes, `useSentinel` observes and `WatchContextBadge` reports.
   *
   * The charts used to be handed `ceStrike={null} peStrike={null}` literals and
   * fell back to their own option-chain poll, which is why the strike controls
   * appeared not to work. They now draw the selection, and nothing else.
   */
  const { selection, instruments } = useSentinelWatch();

  /**
   * What the engine last read off the selected watch. The SELECTION of that
   * watch is no longer held here — it lives in the canonical state, so the
   * feed, the charts and the market controls cannot disagree about which watch
   * is current. This is only the timeline/reading payload that comes back for
   * it, which the conditions panel and the reading footer render.
   */
  const [observation, setObservation] = useState<WatchObservation | null>(null);

  /**
   * What `/observe` read for the SELECTED MARKET, as a chart focus.
   *
   * This is the "selecting a market starts Sentinel watching those charts"
   * path. It is subordinate to `observation` inside `SentinelLiveCharts` — a
   * watch the user created is the more specific claim — but it is what makes
   * the panel truthful in the far more common state of having no watch at all.
   *
   * Memoised on identity of the response's own object: `/observe` polls every
   * 45s and produces a fresh model each time, and an unmemoised focus would
   * hand the charts a new object every poll, restarting their candle hooks.
   * Same class of bug as the `observationKey` guard in `StrategyTimelineFeed`.
   */
  const engineRead = useMemo(() => engineFocusFrom(model.contractWatch), [model.contractWatch]);

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
        What Sentinel is watching — the index the setup lives in, plus BOTH
        legs of the strike, so "which side is actually confirming" is one
        glance. Directly after the strategy workspace: the user picks a
        market, expiry, side and strike up there, and this is that selection
        drawn.

        Full width because three charts need real width before the comparison
        is legible at all.

        Unconditional. `focus` is what changes — null until a watch is
        selected in the feed, at which point the component repoints itself to
        the watch's market/strike and to the engine's own timeframe, and the
        reading footer appears beneath it. See the header comment for why the
        old `{observation && …}` gate was the wrong lever.

        `expiry`/`ceStrike`/`peStrike` come from the canonical selection. They
        were literal `null`s from 2026-08-16 until 2026-08-18, which left the
        component resolving its own nearest expiry and ATM strikes — so the
        strike the operator picked and the contract on screen were unrelated.
      */}
      <SentinelLiveCharts
        symbol={symbol}
        marketName={marketName}
        expiry={selection.expiry}
        ceStrike={instruments.call?.strike ?? null}
        peStrike={instruments.put?.strike ?? null}
        focus={observation?.focus ?? null}
        engineRead={engineRead}
        footer={
          observation ? (
            <SentinelChartReading reading={observation.reading} />
          ) : model.contractWatch ? (
            <SentinelContractReading watch={model.contractWatch} />
          ) : undefined
        }
      />

      {/*
        ── the band ────────────────────────────────────────────────────────
        Feed on the left, the user's conditions in the middle, and the two
        read-only observation cards stacked on the right.

        Risk radar, session timeline, session stats and quick actions were
        removed from this surface on 2026-08-16 at the product owner's
        direction; the components are archived under `archive/` rather than
        deleted. The band is now one row, so the feed no longer needs
        `row-span-2` and the timeline no longer has a width to fill.

        `items-start` is deliberate: without it the grid stretches every cell
        to the tallest row, which pads the emotion report to the height of a
        long feed and leaves a card that is mostly empty space.

        The 5/3/4 split is measured off the reference rather than guessed: on
        its 1372px content width the panels ran 550 · 392 · 430, i.e. the feed
        takes ~5/12 and the other two divide the remaining 7 almost evenly.
        Kept through the removals so the feed and conditions panels do not
        move sideways relative to what was already signed off.
      */}
      <div className="grid grid-cols-12 items-start gap-4">
        <div className="col-span-12 xl:col-span-5">
          {/* Replaces the old generic ObservationCard (market-wide analysis +
              model confidence bar), which said nothing about whether the
              user's OWN strategy was working. The focus panel is suppressed
              here — its conditions half is the panel immediately to the right. */}
          <StrategyTimelineFeed onObservationChange={setObservation} showFocusPanel={false} />
        </div>

        <div className="col-span-12 md:col-span-6 xl:col-span-3">
          <StrategyConditionsPanel timeline={observation?.timeline ?? null} onEdit={editConditions} />
        </div>

        <div className="col-span-12 space-y-4 md:col-span-6 xl:col-span-4">
          <EmotionMirror emotion={model.emotion} />
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
