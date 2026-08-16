'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, fetchTimeline, listWatches } from '@/lib/sentinel/sentinelPy';
import type { Timeline, TimelineEvent, TimelineReading, WatchState, WatchSummary } from '@/lib/sentinel/sentinelPy';
import { focusFromTimeline, type ChartFocus } from '@/lib/sentinel/chartFocus';
import { StrategyFocusPanel } from './StrategyFocusPanel';
import { TimelineEventCard } from './TimelineEventCard';

/**
 * What the selected watch puts under observation, reported upward so the
 * charts can be drawn on it.
 *
 * The selector lives here because this is where the watches are already
 * loaded; duplicating that fetch one level up would mean two lists that can
 * disagree about which watch is selected.
 */
export interface WatchObservation {
  focus: ChartFocus;
  reading: TimelineReading | null;
  /**
   * The whole timeline for the selected watch, so panels beside the feed (the
   * conditions contract) render the SAME watch the feed and the charts are
   * showing. Publishing the object rather than re-fetching it one level up is
   * the point: a second fetch is a second selection that can disagree with
   * this one about which watch is current.
   */
  timeline: Timeline;
}

const POLL_MS = 10_000;

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
 * How each watch state reads in the selector. Plain words rather than the
 * engine's enum: "IN_TRADE" is a state name, "Active" is what the user would
 * call it. Deliberately not shared with `StrategyFocusPanel`'s badge map —
 * that one styles a status chip, this one fills an `<option>`, and merging
 * them would couple a tone to a word for no gain.
 */
const STATE_WORD: Record<WatchState, string> = {
  IDLE: 'Watching',
  FORMING: 'Forming',
  CONFIRMED: 'Confirmed',
  IN_TRADE: 'Active',
  EXITED: 'Closed',
};

/**
 * Live per-strategy feed: newest first, only events about the user's own
 * watch. Replaces the old generic observation panel, which reported
 * market-wide analysis and a model confidence bar that said nothing about
 * whether THIS strategy was working.
 */
export function StrategyTimelineFeed({
  onObservationChange,
  showFocusPanel = true,
}: {
  /**
   * Called when the selected watch — or what the engine last read off it —
   * changes. Optional: the feed is fully usable on its own, and nothing here
   * depends on anyone listening.
   */
  onObservationChange?: (next: WatchObservation | null) => void;
  /**
   * Whether to render `StrategyFocusPanel` above the feed.
   *
   * Defaults to true so every existing caller is unchanged. The dashboard
   * passes false: it renders `StrategyConditionsPanel` in the column beside
   * this one, and the focus panel's own condition list would then be the same
   * ticks twice, side by side. Its other half (strategy history) is what the
   * session-stats grid on the same screen already aggregates.
   */
  showFocusPanel?: boolean;
} = {}) {
  const [watches, setWatches] = useState<WatchSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState<'none' | 'notFound' | 'failed'>('none');
  const [loading, setLoading] = useState(true);

  // Guards against a slow response for watch A landing after the user has
  // already switched to watch B and overwriting the newer feed.
  const requestRef = useRef(0);

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

  const load = useCallback(async (watchId: string) => {
    const ticket = ++requestRef.current;
    try {
      const next = await fetchTimeline(watchId);
      if (ticket !== requestRef.current) return;
      setTimeline(next);
      setError('none');
    } catch (err) {
      if (ticket !== requestRef.current) return;
      // A 404 is "this watch has no timeline yet", which is a normal empty
      // state rather than a failure worth alarming anyone about.
      setError(err instanceof ApiError && err.status === 404 ? 'notFound' : 'failed');
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void load(selectedId);
    const timer = setInterval(() => void load(selectedId), POLL_MS);
    return () => clearInterval(timer);
  }, [selectedId, load]);

  /**
   * The feed re-polls every 10s and gets a fresh `Timeline` object each time,
   * so publishing on object identity would restart the charts' data hooks
   * every poll for no reason. This key changes only when something the charts,
   * the reading strip or the conditions panel actually render has changed —
   * `reading.at` moves whenever the engine has measured a new sweep, so it
   * covers the measurements without listing every one of them.
   *
   * The conditions signature is part of the key because the conditions panel
   * now consumes this: a rule flipping met/unmet changes nothing else in the
   * list, and without it the panel would keep showing the previous sweep's
   * ticks until some unrelated field moved.
   */
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
    <div className="flex h-full flex-col gap-4">
      {showFocusPanel && timeline && <StrategyFocusPanel timeline={timeline} />}
      <Shell
      selector={
        /*
         * Shown even for a single watch, unlike before. The reference puts the
         * instrument in the header for a reason: the feed, the charts above it
         * and the conditions panel beside it are all scoped to ONE watch, and
         * a header that names it is the only thing on screen saying which.
         */
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setTimeline(null);
          }}
          className="max-w-[190px] truncate rounded-lg border border-border bg-bg px-2 py-1 text-[11px] text-text"
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

      {error === 'notFound' || visible.length === 0 ? (
        <Empty>
          {error === 'notFound'
            ? 'Start watching a strategy to see live updates.'
            : `Watching your strategy${selected ? ` on ${selected.symbol}` : ''}… conditions not yet met.`}
        </Empty>
      ) : (
        /*
         * Scrolls rather than truncating behind a "View all" link.
         *
         * The reference design ends each feed section with one, and it is the
         * wrong control here: this feed is already collapsed (a run of forty
         * identical FORMING sweeps is one card — see `_collapse` in the
         * service), so what a cut-off hides is not repetition, it is older
         * *distinct* events. A link that navigates away from a live surface to
         * read them is also a link away from the thing that is updating.
         *
         * `overscroll-contain` keeps a scroll that reaches the end of the feed
         * from continuing into the page behind it.
         */
        <div className="-mr-1 max-h-[560px] overflow-y-auto overscroll-contain pr-1">
          <div className="flex flex-col gap-2">
            {visible.map((event) => (
              <TimelineEventCard key={`${event.id}-${event.kind}`} event={event} watch={timeline!.watch} />
            ))}
          </div>
        </div>
      )}
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
