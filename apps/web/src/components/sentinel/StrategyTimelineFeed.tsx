'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchTimeline } from '@/lib/sentinel/sentinelPy';
import type { Timeline, TimelineEvent } from '@/lib/sentinel/sentinelPy';
import { sentinelKeys } from '@/lib/sentinel/queryKeys';
import { pollIntervalMs } from '@/lib/sentinel/retryPolicy';
import { useWatchSessions } from '@/lib/sentinel/useStrategyWorkspace';
import { useSessionStore } from '@/lib/store/sessionStore';
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
const MIN_STRENGTH = 0.6;

/**
 * Live per-strategy feed: newest first, only events about the user's own
 * watch. Replaces the old generic observation panel, which reported
 * market-wide analysis and a model confidence bar that said nothing about
 * whether THIS strategy was working.
 */
export function StrategyTimelineFeed() {
  const userId = useSessionStore((s) => s.user?.id ?? null);

  /**
   * The watch list comes from the SHARED hook, not from its own fetch.
   *
   * This component used to call `listWatches()` on mount. It renders inside
   * `SentinelDashboard`, which renders inside `SentinelWorkspace`, which also
   * renders `SentinelStrategyWorkspace` — and that was polling the very same
   * `/sentinel-py/watch` route on its own timer. Two components, two timers,
   * one endpoint, one per-IP rate-limit bucket, each one making the other more
   * likely to be the request that got refused.
   *
   * Reading through `useWatchSessions` puts both on one query key, and one key
   * is one in-flight request however many components ask for it. It adds no
   * traffic here: on `/sentinel` that entry is already warm and already
   * polling.
   */
  const { watches, loading } = useWatchSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default the selection to a live watch, and keep it pointing at something
  // that still exists. The user's own choice outranks every poll after it.
  useEffect(() => {
    if (watches.length === 0) return;
    setSelectedId((current) =>
      current !== null && watches.some((w) => w.id === current)
        ? current
        : (watches.find((w) => w.state !== 'EXITED')?.id ?? watches[0]?.id ?? null),
    );
  }, [watches]);

  const timelineQuery = useQuery({
    queryKey: sentinelKeys.timeline(userId, selectedId ?? ''),
    queryFn: () => fetchTimeline(selectedId as string),
    enabled: selectedId !== null,
    // Caching per watch id is what replaced the manual request-ticket guard: a
    // slow response for watch A is written to watch A's cache entry, so it
    // cannot land on top of the feed for watch B after the user switches.
    refetchInterval: (q) =>
      pollIntervalMs({
        failing: q.state.status === 'error',
        hasActiveWatches: watches.some((w) => w.state !== 'EXITED'),
      }),
    refetchIntervalInBackground: false,
    // A 404 is "this watch has no timeline yet" — a normal empty state, and
    // retrying it would only delay saying so.
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const timeline: Timeline | null = timelineQuery.data ?? null;
  const error: 'none' | 'notFound' | 'failed' = !timelineQuery.error
    ? 'none'
    : timelineQuery.error instanceof ApiError && timelineQuery.error.status === 404
      ? 'notFound'
      : 'failed';

  const visible = useMemo(() => {
    if (!timeline) return [] as TimelineEvent[];
    const strong = timeline.events.filter((e) => e.strength >= MIN_STRENGTH);

    // "Wait and Watch" is REPLACED by "Confirmed", not stacked beneath it:
    // once the setup is confirmed, the earlier "still forming" line is no
    // longer true and leaving it in the feed reads as two live states at once.
    const confirmedAt = strong.find((e) => e.kind === 'confirmed')?.at;
    const withoutStaleForming = confirmedAt
      ? strong.filter((e) => !(e.kind === 'wait_and_watch' && e.at <= confirmedAt))
      : strong;

    // Anything after a final event is not shown: once the invalidation or the
    // projected level is reached the trade is over, and later chatter would
    // imply it is still running.
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
    <div className="flex flex-col gap-4">
      {timeline && <StrategyFocusPanel timeline={timeline} />}
      <Shell
      selector={
        // Changing the selection needs no manual clear: each watch's feed is
        // its own cache entry, so switching renders that watch's data (or its
        // loading state) rather than leaving the previous watch's events up.
        watches.length > 1 ? (
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded-lg border border-border bg-bg px-2 py-1 text-[11px] text-text"
            aria-label="Select which watch to display"
          >
            {watches.map((w) => (
              <option key={w.id} value={w.id}>
                {[w.symbol, w.strike, w.optionType].filter(Boolean).join(' ')}
                {w.state === 'EXITED' ? ' (closed)' : ''}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      {isClosed && timeline && (
        <div className="mb-3 rounded-xl border border-border bg-bg2 p-3.5">
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
      </Shell>
    </div>
  );
}

function Shell({ children, selector }: { children: React.ReactNode; selector?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-bold text-text">Strategy Feed</h2>
        {selector}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[12px] text-faint">{children}</p>;
}
