'use client';

import { useState } from 'react';
import { useSentinel } from '@/lib/sentinel/useSentinel';
import { useSessionStore } from '@/lib/store/sessionStore';
import { classifyDay, extractMarketContext, extractSafetyFeed, pushworthyCards, suggestedLesson } from '@/lib/sentinel/deriveContext';
import { DEFAULT_MARKET, findMarket } from '@/lib/sentinel/markets';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { DayClassificationCard } from '@/components/sentinel/DayClassificationCard';
import { MarketContextPanel } from '@/components/sentinel/MarketContextPanel';
import { LiveSafetyFeed } from '@/components/sentinel/LiveSafetyFeed';
import { ContextualTraining } from '@/components/sentinel/ContextualTraining';
import { SentinelTimeline } from '@/components/sentinel/SentinelTimeline';
import { SentinelLocked } from '@/components/sentinel/SentinelLocked';

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
 * Shares the standard Sidebar/TopBar shell like every other workspace (a
 * first pass rendered this with no chrome at all — reverted 2026-07-21,
 * see nav-config.tsx: it left no way to navigate back out).
 */
export default function SentinelPage() {
  // User-centric market selection: the "market head" selector drives the
  // entire workspace. Changing it re-runs /observe for that symbol
  // (useSentinel) and every panel below re-derives.
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const { data, demoMode, loading } = useSentinel(symbol);
  const status = useSessionStore((s) => s.status);
  const hasCapability = useSessionStore((s) => s.hasCapability);

  const market = findMarket(symbol);
  const observations = data?.observations ?? [];
  const signals = data?.signals ?? [];

  const locked = status === 'authenticated' && !hasCapability('sentinel') && !demoMode;

  if (locked) {
    return <SentinelLocked />;
  }

  const day = classifyDay(signals);
  const { tags, dimensions } = extractMarketContext(signals);
  const safetyCards = extractSafetyFeed(observations, data?.synthesis ?? null);
  const lesson = suggestedLesson(safetyCards);
  const lastUpdated = loading ? 'refreshing…' : 'just now';

  // What's driving the read, stated honestly: sample data when signed out,
  // otherwise live Dhan market data (candles + breadth/VIX) for any market.
  const sourceLabel = demoMode ? 'sample data — sign in for live analysis' : 'live market data';

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-[1440px] space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-text">Sentinel</h1>
            <p className="text-[12.5px] text-muted">
              Reading <span className="font-semibold text-text">{market.name}</span> · {sourceLabel}
              {loading && !demoMode && ' · refreshing…'}
            </p>
          </div>
          <MarketSelector value={symbol} onChange={setSymbol} />
        </div>

        <DayClassificationCard day={day} lastUpdated={lastUpdated} />
        <MarketContextPanel tags={tags} dimensions={dimensions} />
        <LiveSafetyFeed cards={pushworthyCards(safetyCards)} />
        <ContextualTraining title={lesson.title} blurb={lesson.blurb} />
        <SentinelTimeline cards={safetyCards} />

        <p className="pb-6 text-center text-[11px] text-faint">
          Sentinel observes market context and behavior in parallel. It never executes trades and never gives buy,
          sell, entry, exit or target recommendations.
        </p>
      </main>
    </div>
  );
}
