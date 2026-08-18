'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CandleLoader } from '@tradew/ui';
import { ApiError, fetchTimeline } from '@/lib/sentinel/sentinelPy';
import type { Timeline, TimelineEvent, TimelineReading, WatchState } from '@/lib/sentinel/sentinelPy';
import { focusFromTimeline, type ChartFocus } from '@/lib/sentinel/chartFocus';
import { sentinelKeys } from '@/lib/sentinel/queryKeys';
import { faultMessage } from '@/lib/sentinel/faults';
import { pollIntervalMs } from '@/lib/sentinel/retryPolicy';
import { useWatchSessions } from '@/lib/sentinel/useStrategyWorkspace';
import { useSentinelWatch } from '@/lib/sentinel/WatchContext';
import { instrumentLabel, watchPairLabel } from '@/lib/sentinel/watchState';
import { useSessionStore } from '@/lib/store/sessionStore';
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
  const { watches, loading, fault, reconnecting, refresh } = useWatchSessions();

  /**
   * WHICH watch is displayed is canonical state, not feed-local state.
   *
   * It used to be a `useState` here, defaulted to any live watch. That made the
   * feed's instrument independent of everything else on the page: the feed
   * could report NIFTY 24350 CE while the market control said SENSEX and the
   * charts drew a third contract, because each had picked its own. Selecting a
   * watch now REPOINTS the whole workspace at that watch's instrument
   * (`adoptWatch`), and changing the market/expiry/strike re-resolves which
   * watch — if any — describes what is on screen (`syncWatches`).
   */
  const { selection, adoptWatch, syncWatches } = useSentinelWatch();
  const selectedId = selection.selectedWatchId;

  /**
   * Reconcile against the real list whenever it changes. `syncWatches` returns
   * the same selection object when nothing moved, so the 10s re-poll does not
   * churn the workspace.
   */
  useEffect(() => {
    syncWatches(watches);
  }, [watches, syncWatches]);

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
      // BOTH legs. With only the focused one here, moving the opposite leg
      // would not change the key, so the charts would keep the previous
      // contract's focus until some unrelated field happened to move.
      timeline.watch.ce?.strike,
      timeline.watch.pe?.strike,
      timeline.watch.focusedSide,
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

  const selected = watches.find((w) => w.id === selectedId) ?? null;
  const isClosed = timeline?.watch.state === 'EXITED';

  /**
   * What the workspace is pointed at right now, named the same way the charts
   * and the toolbar name it. Used only for the "no watch here" empty state, so
   * that sentence names a contract rather than saying "this instrument".
   */
  const currentInstrument = selection.underlyingOnly
    ? selection.symbol
    : // BOTH legs, because both are under observation. Naming only the focused
      // one here would tell the operator no watch covers "NIFTY 24200 CALL"
      // while the thing actually not covered is the pair.
      [
        instrumentLabel(selection.symbol, selection.expiry, selection.callStrike, 'CE'),
        selection.putStrike === null ? null : `${selection.putStrike} PUT`,
      ]
        .filter(Boolean)
        .join(' / ');

  /**
   * ── WHY THIS IS NO LONGER `if (loading) return null` ───────────────────────
   *
   * It rendered NOTHING — not an empty card, nothing at all. `Shell` carries
   * the "Strategy Feed" heading, so while the watch list was in flight the
   * dashboard band showed a card, a card, and a hole where this panel belongs.
   * A request that never settles (sentinel-py down behind a timeout, a stalled
   * poll) is then indistinguishable from a feature that does not exist, which
   * is exactly how it was reported: "the strategy feed is missing".
   *
   * The shell is now always rendered and the BODY says which state it is in.
   */
  if (loading) {
    return (
      <Shell>
        <Empty>Checking which strategies you have running…</Empty>
      </Shell>
    );
  }

  /**
   * ⚠️ A FEED FAULT IS NOT AN EMPTY FEED.
   *
   * `useWatchSessions` has always returned `fault`/`reconnecting`, and this
   * component ignored both. So when `/sentinel-py/watch` failed, `watches` fell
   * back to `[]` and the panel said "Start watching a strategy to see live
   * updates" — instructing the user to create a watch when the truth was that
   * the service could not be reached, and hiding the running watches they may
   * already have had.
   *
   * Same class of bug as the 2026-08-17 "NIFTY has no live option chain"
   * message that contradicted itself while the real fault was a refused
   * credential: the UI had no way to say "I could not find out", so it said the
   * only other thing it knew how to say. `SentinelStrategyWorkspace` already
   * distinguishes these three states for the same query; this panel now does
   * too, in the same words.
   */
  if (fault) {
    return (
      <Shell>
        <div className="rounded-xl border border-border bg-bg px-3 py-4 text-center">
          <p className="text-[12px] leading-relaxed text-muted">{faultMessage(fault, 'your watches')}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 text-[11.5px] font-semibold text-teal hover:underline"
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  if (watches.length === 0) {
    return (
      <Shell>
        {/* Transient failures keep the last loaded list, so this line can
            legitimately appear above a real empty state. */}
        {reconnecting && <Retrying subject="your watches" />}
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
           *
           * Changing the selection needs no manual clear: each watch's feed is
           * its own cache entry, so switching renders that watch's data (or its
           * loading state) rather than leaving the previous watch's events up.
           */
          <select
            value={selectedId ?? ''}
            /*
             * Selecting here adopts the watch as the CANONICAL selection, so
             * the charts, `/observe`, the watch-market controls and the toolbar
             * readout all move to that instrument together. Publishing a
             * feed-local id instead is what let the feed name one contract
             * while the rest of the page was on another.
             */
            onChange={(e) => {
              const next = watches.find((w) => w.id === e.target.value);
              if (next) adoptWatch(next);
            }}
            className="max-w-[190px] truncate rounded-lg border border-border bg-bg px-2 py-1 text-[11px] text-text"
            aria-label="Select which watch to display"
          >
            {/*
              Present only while no watch describes what is on screen. Without
              it a `<select>` whose value is '' silently displays its first
              option, so the feed would LOOK like it was reporting that watch
              while showing nothing for it.
            */}
            {selectedId === null && <option value="">No watch on this instrument</option>}
            {watches.map((w) => (
              <option key={w.id} value={w.id}>
                {watchPairLabel(w)} ({STATE_WORD[w.state]})
              </option>
            ))}
          </select>
        }
      >
        {/* The list on screen is the last one that loaded; say so rather than
            presenting stale rows as current. */}
        {reconnecting && <Retrying subject="your watches" />}
        {isClosed && timeline && (
          <div className="mb-3 rounded-xl border border-border bg-hover p-3.5">
            <p className="text-[12px] font-bold text-text">Trade Complete</p>
            <p className="mt-1 text-[11.5px] text-muted">
              {watchPairLabel(timeline.watch)} —
              this watch is closed. The events below are its final history.
            </p>
          </div>
        )}

        {error === 'failed' && (
          <p className="mb-3 text-[11.5px] text-amber">
            Could not refresh the feed just now — showing the last known state.
          </p>
        )}

        {selectedId === null ? (
          /*
           * Watches exist, but none of them is on the instrument currently
           * selected. Said plainly rather than falling through to "conditions
           * not yet met", which would claim a watch is running on this contract
           * when the running watch is on a different one. The previous watch is
           * NOT stopped — it keeps evaluating in services/sentinel-py, and
           * picking it in the selector above brings the whole workspace back to
           * its instrument.
           */
          <Empty>
            No watch is running on {currentInstrument}. Start one under &ldquo;Watch market&rdquo;, or pick another
            watch above to follow it instead.
          </Empty>
        ) : error === 'notFound' || visible.length === 0 ? (
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

/**
 * Same wording as `SentinelStrategyWorkspace`'s, deliberately: both describe
 * the SAME query failing, and two different sentences for one fault reads as
 * two different problems.
 */
function Retrying({ subject }: { subject: string }) {
  return (
    <p role="status" aria-live="polite" className="mb-2 flex items-center gap-1.5 text-[11px] text-amber">
      <CandleLoader size="sm" decorative />
      Reconnecting — showing the last loaded copy of {subject}.
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[12px] text-faint">{children}</p>;
}
