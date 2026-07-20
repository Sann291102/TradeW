'use client';

import { useSentinel } from '@/lib/sentinel/useSentinel';
import { AlertCallout } from '@/components/sentinel/AlertCallout';
import { ReflectionCards } from '@/components/sentinel/ReflectionCards';
import { AgentTimeline } from '@/components/sentinel/AgentTimeline';
import { ObservationFeed } from '@/components/sentinel/ObservationFeed';
import { SessionSummary } from '@/components/sentinel/SessionSummary';
import { TradingJournal } from '@/components/sentinel/TradingJournal';
import { DemoModeBanner } from '@/components/sentinel/DemoModeBanner';

/**
 * Sentinel workspace — layout per docs/product-architecture/SENTINEL.md §5:
 * alert callout → reflection cards → (agent timeline / observation feed /
 * session summary) → trading journal. Shares the same top bar/sidebar chrome
 * as every other workspace (the root layout's `AppFrame` already wraps this
 * route) — this page no longer renders its own duplicate header. Observation
 * only: no buy/sell/entry/exit language anywhere.
 */
export default function SentinelPage() {
  const { data, summary, journal, demoMode, loading, refresh, addJournal } = useSentinel();

  const observations = data?.observations ?? [];
  const signals = data?.signals ?? [];

  return (
    <div className="min-h-screen">
      {demoMode && <DemoModeBanner />}

      <main className="mx-auto max-w-[1200px] space-y-5 p-5">
        <div className="flex items-center justify-end gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className={`inline-block h-2 w-2 rounded-full ${loading ? 'bg-amber' : 'bg-up'} animate-pulse`} />
            {loading ? 'Synthesizing…' : 'Agent Desk: Observing'}
          </span>
          <button
            onClick={() => void refresh()}
            className="rounded-lg border border-border2 px-3 py-1.5 text-xs text-muted hover:bg-hover"
          >
            ⟳ Refresh
          </button>
        </div>

        <AlertCallout synthesis={data?.synthesis ?? null} />
        <ReflectionCards observations={observations} />

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <AgentTimeline signals={signals} />
          <ObservationFeed observations={observations} />
          <SessionSummary summary={summary} />
        </section>

        <TradingJournal journal={journal} onAdd={addJournal} />

        <p className="pb-6 text-center text-[11px] text-faint">
          Sentinel observes, researches, remembers, teaches, explains and protects. It never executes trades and
          never gives buy, sell, entry, exit or target recommendations.
        </p>
      </main>
    </div>
  );
}
