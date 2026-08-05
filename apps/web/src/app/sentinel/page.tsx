'use client';

import { useState } from 'react';
import { useSentinel } from '@/lib/sentinel/useSentinel';
import { useSessionStore } from '@/lib/store/sessionStore';
import { classifyDay, extractMarketContext, extractSafetyFeed, pushworthyCards, suggestedLesson } from '@/lib/sentinel/deriveContext';
import { DEFAULT_MARKET, findMarket } from '@/lib/sentinel/markets';
import type { StrategyMode } from '@/lib/sentinel/types';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { OptionChainPanel } from '@/components/sentinel/OptionChainPanel';
import { StrategySelector } from '@/components/sentinel/StrategySelector';
import { MarketReasoningPanel } from '@/components/sentinel/MarketReasoningPanel';
import { SideInFocusCard, WaitingForConfirmation } from '@/components/sentinel/SideInFocusCard';
import { DayClassificationCard } from '@/components/sentinel/DayClassificationCard';
import { SentinelLiveCharts } from '@/components/sentinel/SentinelLiveCharts';
import { MarketContextPanel } from '@/components/sentinel/MarketContextPanel';
import { LiveSafetyFeed } from '@/components/sentinel/LiveSafetyFeed';
import { ContextualTraining } from '@/components/sentinel/ContextualTraining';
import { SentinelTimeline } from '@/components/sentinel/SentinelTimeline';
import { SentinelLocked } from '@/components/sentinel/SentinelLocked';
import { SentinelHeader } from '@/components/sentinel/SentinelHeader';

/**
 * Sentinel — Market Context Intelligence workspace.
 *
 * Redesigned from first principles: this used to render an "AI dashboard"
 * (AI Reflection Cards / Agent Activity Timeline / Observation Feed /
 * Session Summary — archived to archive/, see archive/README.md) that
 * exposed how the multi-agent backend reasons. It now answers five
 * standing questions instead — what kind of day is this, what's the
 * current market context, what should the trader watch, why, and (where
 * genuinely derivable) which side has stronger confirmation — and shows
 * only the conclusion, never the internal agent architecture producing it.
 * Same backend, same auth, same entitlement gating (SUBSCRIPTIONS.md §4) —
 * only the presentation changed.
 *
 * `SentinelIntelligencePanel` — the second reasoning engine's surface
 * (citation-grounded multi-agent verdicts plus the three-panel visual
 * strategy workspace: chart, option context, AI annotations) that used to be
 * embedded here between the day classification and market context cards —
 * was removed 2026-08-05 per explicit product direction: this workspace
 * should show only the single-conclusion Sentinel read, not a second,
 * separate reasoning surface alongside it. Archived, not deleted, to
 * archive/apps-web-sentinel-intelligence-2026-08-05/ (see archive/README.md).
 *

 * Shares the standard Sidebar/TopBar shell like every other workspace (a
 * first pass rendered this with no chrome at all — reverted 2026-07-21,
 * see nav-config.tsx: it left no way to navigate back out).
 */
export default function SentinelPage() {
  // User-centric market selection: the "market head" selector drives the
  // entire workspace. Changing it re-runs /observe for that symbol
  // (useSentinel) and every panel below re-derives.
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  // Phase 3 — strategy focus (Auto by default) drives the observe call, and
  // the option-chain selection is passed to the panel as observation context.
  const [strategyMode, setStrategyMode] = useState<StrategyMode>('auto');
  // Phase 2 — one or more strategies can be pinned simultaneously in manual mode.
  const [selectedStrategyIds, setSelectedStrategyIds] = useState<string[]>([]);
  // Strikes the trader picked from the Option Chain toolbar control — feeds
  // the CALL/PUT panels in SentinelLiveCharts below. Null until a pick is
  // made (or the panel is never opened), in which case those charts default
  // to the ATM strike themselves.
  const [ceStrike, setCeStrike] = useState<number | null>(null);
  const [peStrike, setPeStrike] = useState<number | null>(null);
  const { data, unavailable, loading } = useSentinel(symbol, { strategyMode, selectedStrategyIds });
  const status = useSessionStore((s) => s.status);
  const hasCapability = useSessionStore((s) => s.hasCapability);

  const onStrategyChange = (next: { mode: StrategyMode; selectedStrategyIds?: string[] }) => {
    setStrategyMode(next.mode);
    setSelectedStrategyIds(next.selectedStrategyIds ?? []);
  };

  const market = findMarket(symbol);
  const observations = data?.observations ?? [];
  const signals = data?.signals ?? [];

  const locked = status === 'authenticated' && !hasCapability('sentinel');

  if (locked) {
    return <SentinelLocked />;
  }

  // No observation, and nothing invented in its place. Each fault is named
  // for what it actually is — the old single "sign in for live analysis"
  // banner was shown for API outages and dead-service errors too.
  if (unavailable) {
    const fault =
      unavailable.kind === 'unauthenticated'
        ? {
            title: 'Not signed in',
            detail: 'Sentinel runs its observation against your account. Sign in to get a live read — no sample analysis is shown in the meantime.',
          }
        : unavailable.kind === 'api-unreachable'
          ? {
              title: 'API not connected',
              detail: `The TradeW API could not be reached, so no observation could be run for ${market.name}. Start services/api (port 4000) and reload.`,
            }
          : {
              title: 'Sentinel service not connected',
              detail: `The API answered but Sentinel could not complete the observation (HTTP ${unavailable.status}: ${unavailable.message}). Check that services/sentinel is running on port 4010.`,
            };

    return (
      <div className="min-h-full bg-bg">
        <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 sm:py-6">
          <SentinelHeader
            premium={hasCapability('sentinel')}
            status={
              <>
                Reading <span className="font-semibold text-muted">{market.name}</span> · {fault.title.toLowerCase()}
              </>
            }
            controls={
              <>
                <OptionChainPanel symbol={symbol} />
                <MarketSelector value={symbol} onChange={setSymbol} />
              </>
            }
          />

          <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-elev2">
            <p className="text-[14px] font-bold text-text">{fault.title}</p>
            <p className="mx-auto mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted">{fault.detail}</p>
          </div>

          <p className="pb-6 text-center text-[11px] text-faint">
            Sentinel observes market context and behavior in parallel. It never executes trades and never gives buy,
            sell, entry, exit or target recommendations.
          </p>
        </main>
      </div>
    );
  }

  // The Market Intelligence and Confidence engines are authoritative when the
  // response carries them; the signal-derived path below is the demo/offline
  // fallback only (see lib/sentinel/deriveContext.ts).
  const day = classifyDay(signals, data?.marketProfile, data?.confidence);
  const { tags, dimensions } = extractMarketContext(signals, {
    profile: data?.marketProfile,
    confidence: data?.confidence,
    risk: data?.risk,
  });
  const safetyCards = extractSafetyFeed(observations, data?.synthesis ?? null);
  const lesson = suggestedLesson(safetyCards);
  const lastUpdated = loading ? 'refreshing…' : 'just now';

  // Past the `unavailable` guard above, the observation is always a real one.
  const sourceLabel = 'live market data';

  return (
    <div className="min-h-full bg-bg">
      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 sm:py-6">
        <SentinelHeader
          premium={hasCapability('sentinel')}
          status={
            <>
              Reading <span className="font-semibold text-muted">{market.name}</span> · {sourceLabel}
              {loading && ' · refreshing…'}
            </>
          }
          controls={
            <>
              <OptionChainPanel symbol={symbol} onSelectionChange={({ ce, pe }) => { setCeStrike(ce); setPeStrike(pe); }} />
              <MarketSelector value={symbol} onChange={setSymbol} />
            </>
          }
        />

        {/* Two-column institutional layout: the market read (what the tape is
            doing) on the left, Sentinel's own commentary on it in the right
            rail. Collapses to one column below xl — the charts need real
            width before the split is worth having. */}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-5">
            <DayClassificationCard day={day} lastUpdated={lastUpdated} explanation={data?.explanation} />
            <SentinelLiveCharts symbol={symbol} marketName={market.name} ceStrike={ceStrike} peStrike={peStrike} />
            <MarketContextPanel tags={tags} dimensions={dimensions} />
          </div>

          <div className="min-w-0 space-y-5">
            <StrategySelector
              mode={strategyMode}
              selectedStrategyIds={selectedStrategyIds}
              advices={data?.strategyAdvices}
              onChange={onStrategyChange}
            />
            {data?.sideInFocus ? (
              <SideInFocusCard focus={data.sideInFocus} />
            ) : (
              <WaitingForConfirmation publication={data?.publication} />
            )}
            <MarketReasoningPanel
              behaviour={data?.marketBehaviour}
              lifecycles={data?.strategyLifecycles}
              crossValidation={data?.institutionalCrossValidation}
            />
            <LiveSafetyFeed cards={pushworthyCards(safetyCards)} />
            <ContextualTraining title={lesson.title} blurb={lesson.blurb} />
            <SentinelTimeline cards={safetyCards} entries={data?.timeline} />
          </div>
        </div>

        <p className="pb-6 text-center text-[11px] text-faint">
          Sentinel observes market context and behavior in parallel. It never executes trades and never gives buy,
          sell, entry, exit or target recommendations.
        </p>
      </main>
    </div>
  );
}
