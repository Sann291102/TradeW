'use client';

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
const MIN_STRENGTH = 0.6;

/**
 * Live per-strategy feed: newest first, only events about the user's own
 * watch. Replaces the old generic observation panel, which reported
 * market-wide analysis and a model confidence bar that said nothing about
 * whether THIS strategy was working.
 */
export function StrategyTimelineFeed() {
  const [watches, setWatches] = useState<WatchSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    listWatches()
      .then((rows) => {
        if (cancelled) return;
        setWatches(rows);
        setSelectedId((current) => current ?? rows.find((w) => w.state !== 'EXITED')?.id ?? rows[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setWatches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const selected = watches?.find((w) => w.id === selectedId) ?? null;
  const isClosed = timeline?.watch.state === 'EXITED';

  if (loading) return null;

  if (!watches || watches.length === 0) {
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
        watches.length > 1 ? (
          <select
            value={selectedId ?? ''}
            // No manual clear needed: the timeline is keyed by watch id, so
            // selecting a different one reads that watch's own cache entry.
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
