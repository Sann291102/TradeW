'use client';

<<<<<<< HEAD
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchTimeline } from '@/lib/sentinel/sentinelPy';
import type { Timeline, TimelineEvent, TimelineReading, WatchState } from '@/lib/sentinel/sentinelPy';
import { sentinelKeys } from '@/lib/sentinel/queryKeys';
import { pollIntervalMs } from '@/lib/sentinel/retryPolicy';
import { useWatchSessions } from '@/lib/sentinel/useStrategyWorkspace';
import { useSessionStore } from '@/lib/store/sessionStore';
import { focusFromTimeline, type ChartFocus } from '@/lib/sentinel/chartFocus';
import { StrategyFocusPanel } from './StrategyFocusPanel';
import { TimelineEventCard } from './TimelineEventCard';

export interface WatchObservation {
  focus: ChartFocus;
  reading: TimelineReading | null;
  timeline: Timeline;
}

=======
import { useEffect, useMemo, useState } from 'react';
import { ApiError, listWatches } from '@/lib/sentinel/sentinelPy';
import type { TimelineEvent, WatchSummary } from '@/lib/sentinel/sentinelPy';
import { useStrategyTimeline } from '@/lib/query/useSentinel';
import { StrategyFocusPanel } from './StrategyFocusPanel';
import { TimelineEventCard } from './TimelineEventCard';

/**
 * Minimum `strength` an event needs before the user sees it.
 *
 * `strength` is NOT a confidence score — this service has none and invents
 * none. It is the real ratio of mandatory conditions met to mandatory
 * conditions the user defined, so 0.6 means "at least 60% of your own rules
 * are satisfied". Events below it are still recorded in `WatchObservation`
 * (the audit trail answers "why didn't I see anything?"); they just do not
 * reach the feed.
 */
>>>>>>> origin/claude/tradew-frontend-audit-p8igb0
const MIN_STRENGTH = 0.6;

const STATE_WORD: Record<WatchState, string> = {
  IDLE: 'Watching',
  FORMING: 'Forming',
  CONFIRMED: 'Confirmed',
  IN_TRADE: 'Active',
  EXITED: 'Closed',
};

export function StrategyTimelineFeed({
  onObservationChange,
  showFocusPanel = true,
}: {
  onObservationChange?: (next: WatchObservation | null) => void;
  showFocusPanel?: boolean;
} = {}) {
  const userId = useSessionStore((s) => s.user?.id ?? null);
  const { watches, loading } = useWatchSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
<<<<<<< HEAD
=======
  const [loading, setLoading] = useState(true);

  // The watch id is part of the query key, which replaces the request-ticket
  // ref this used to need: a slow response for watch A lands in A's cache
  // entry and cannot overwrite B's feed, and switching back to A shows its
  // last-known timeline immediately instead of blanking.
  const timelineQuery = useStrategyTimeline(selectedId);
  const timeline = timelineQuery.data ?? null;

  // A 404 is "this watch has no timeline yet", which is a normal empty state
  // rather than a failure worth alarming anyone about. Note this is decided
  // AFTER the shared retry policy has run, and that policy deliberately does
  // not retry a 404 — only 429s, 5xxs and network drops.
  const error: 'none' | 'notFound' | 'failed' = !timelineQuery.isError
    ? 'none'
    : timelineQuery.error instanceof ApiError && timelineQuery.error.status === 404
      ? 'notFound'
      : 'failed';
>>>>>>> origin/claude/tradew-frontend-audit-p8igb0

  useEffect(() => {
    if (watches.length === 0) return;
    setSelectedId((current) =>
      current !== null && watches.some((w) => w.id === current)
        ? current
        : (watches.find((w) => w.state !== 'EXITED')?.id ?? watches[0]?.id ?? null),
    );
  }, [watches]);

<<<<<<< HEAD
  const timelineQuery = useQuery({
    queryKey: sentinelKeys.timeline(userId, selectedId ?? ''),
    queryFn: () => fetchTimeline(selectedId as string),
    enabled: selectedId !== null,
    refetchInterval: (q) =>
      pollIntervalMs({
        failing: q.state.status === 'error',
        hasActiveWatches: watches.some((w) => w.state !== 'EXITED'),
      }),
    refetchIntervalInBackground: false,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const timeline: Timeline | null = timelineQuery.data ?? null;
  const error: 'none' | 'notFound' | 'failed' = !timelineQuery.error
    ? 'none'
    : timelineQuery.error instanceof ApiError && timelineQuery.error.status === 404
      ? 'notFound'
      : 'failed';

  const observationKey = timeline
    ? [
        timeline.watch.id,
        timeline.watch.symbol,
        timeline.watch.strike,
        timeline.watch.optionType,
        timeline.watch.expiry,
        timeline.watch.state,
        timeline.watch.timeframe,
        timeline.watch.entryPrice,
        timeline.watch.invalidationPrice,
        timeline.watch.projectedPrice,
        timeline.reading?.at,
        timeline.reading?.unreadable,
        timeline.conditions.map((c) => `${c.id}:${c.met ? 1 : 0}`).join(','),
      ].join('|')
    : '';

  const publishedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onObservationChange) return;
    if (publishedKeyRef.current === observationKey) return;
    publishedKeyRef.current = observationKey;

    const focus = focusFromTimeline(timeline);
    onObservationChange(
      focus && timeline ? { focus, reading: timeline.reading ?? null, timeline } : null,
    );
  }, [observationKey, timeline, onObservationChange]);

=======
>>>>>>> origin/claude/tradew-frontend-audit-p8igb0
  const visible = useMemo(() => {
    if (!timeline) return [] as TimelineEvent[];
    const strong = timeline.events.filter((e) => e.strength >= MIN_STRENGTH);

    const confirmedAt = strong.find((e) => e.kind === 'confirmed')?.at;
    const withoutStaleForming = confirmedAt
      ? strong.filter((e) => !(e.kind === 'wait_and_watch' && e.at <= confirmedAt))
      : strong;

    const finalIndex = withoutStaleForming.findIndex(
      (e) => e.kind === 'invalidation_reached' || e.kind === 'projected_level_reached',
    );
    return finalIndex === -1 ? withoutStaleForming : withoutStaleForming.slice(finalIndex);
  }, [timeline]);

  const selected = watches.find((w) => w.id === selectedId) ?? null;
  const isClosed = timeline?.watch.state === 'EXITED';

  if (loading) return null;

  if (watches.length === 0) {
    return (
      <Shell>
        <Empty>Start watching a strategy to see live updates.</Empty>
      </Shell>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {showFocusPanel && timeline && <StrategyFocusPanel timeline={timeline} />}
      <Shell
        selector={
          <select
            value={selectedId ?? ''}
<<<<<<< HEAD
            onChange={(e) => setSelectedId(e.target.value)}
            className="max-w-[190px] truncate rounded-lg border border-border bg-bg px-2 py-1 text-[11px] text-text"
=======
            // No manual clear needed: the timeline is keyed by watch id, so
            // selecting a different one reads that watch's own cache entry.
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded-lg border border-border bg-bg px-2 py-1 text-[11px] text-text"
>>>>>>> origin/claude/tradew-frontend-audit-p8igb0
            aria-label="Select which watch to display"
          >
            {watches.map((w) => (
              <option key={w.id} value={w.id}>
                {[w.symbol, w.strike, w.optionType].filter(Boolean).join(' ')} ({STATE_WORD[w.state]})
              </option>
            ))}
          </select>
        }
      >
        {isClosed && timeline && (
          <div className="mb-3 rounded-xl border border-border bg-hover p-3.5">
            <p className="text-[12px] font-bold text-text">Trade Complete</p>
            <p className="mt-1 text-[11.5px] text-muted">
              {[timeline.watch.symbol, timeline.watch.strike, timeline.watch.optionType].filter(Boolean).join(' ')} —
              this watch is closed. The events below are its final history.
            </p>
          </div>
        )}

        {error === 'failed' && (
          <p className="mb-3 text-[11.5px] text-amber">
            Could not refresh the feed just now — showing the last known state.
          </p>
        )}

<<<<<<< HEAD
        {error === 'notFound' || visible.length === 0 ? (
          <Empty>
            {error === 'notFound'
              ? 'Start watching a strategy to see live updates.'
              : `Watching your strategy${selected ? ` on ${selected.symbol}` : ''}… conditions not yet met.`}
          </Empty>
        ) : (
          <div className="-mr-1 max-h-[560px] overflow-y-auto overscroll-contain pr-1">
            <div className="flex flex-col gap-2">
              {visible.map((event) => (
                <TimelineEventCard key={`${event.id}-${event.kind}`} event={event} watch={timeline!.watch} />
              ))}
            </div>
          </div>
        )}
=======
      {error === 'failed' && (
        <p className="mb-3 text-[11.5px] text-amber">
          Could not refresh the feed just now — showing the last known state.{' '}
          <button
            type="button"
            onClick={() => void timelineQuery.refetch()}
            className="font-semibold underline underline-offset-2 hover:no-underline"
          >
            Try again
          </button>
        </p>
      )}

      {error === 'notFound' || visible.length === 0 ? (
        <Empty>
          {error === 'notFound'
            ? 'Start watching a strategy to see live updates.'
            : `Watching your strategy${selected ? ` on ${selected.symbol}` : ''}… conditions not yet met.`}
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((event) => (
            <TimelineEventCard key={`${event.id}-${event.kind}`} event={event} watch={timeline!.watch} />
          ))}
        </div>
      )}
>>>>>>> origin/claude/tradew-frontend-audit-p8igb0
      </Shell>
    </div>
  );
}

function Shell({ children, selector }: { children: React.ReactNode; selector?: React.ReactNode }) {
  return (
    <section className="flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="shrink-0 text-[13px] font-bold text-text">Strategy Feed</h2>
        {selector}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[12px] text-faint">{children}</p>;
}

