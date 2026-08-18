'use client';

import { cn } from '@tradew/ui';
import type { Direction, TimelineEvent, TimelineWatch } from '@/lib/sentinel/sentinelPy';
import { formatExpiry } from '@/lib/sentinel/watchModel';
import { watchPairLabel } from '@/lib/sentinel/watchState';

/**
 * One event in the strategy feed.
 *
 * ## Copy
 *
 * The badge labels and messages below are compliant rewrites of the ones in
 * the feed spec. TradeW's product constitution (docs/handbook/00-front-matter
 * ARCH-4, 26-decision-records, root CLAUDE.md Rule 2) forbids
 * Buy/Sell/Entry/Target/Stop language on every surface and names notifications
 * and cards explicitly; `services/sentinel/src/vocabulary/vocabulary.ts`
 * rewrites exactly these words ("stop-loss" -> "invalidation level",
 * "target" -> "projected level"), and sentinel-py's own compliance gate
 * rejects them outright.
 *
 * So: "Stop Loss Hit" -> "Invalidation Reached", "Target Reached" ->
 * "Projected Level Reached", "Trial or Exit" -> "Review", and
 * "Consider reviewing your stop placement" -> a non-directive observation.
 * The structure, colours, ordering and information content the spec asked for
 * are all preserved — only the words that carry a regulatory meaning changed.
 * Every one of these is a single-string edit if the rule is ever relaxed.
 */

interface Props {
  event: TimelineEvent;
  watch: TimelineWatch;
}

type Tone = 'orange' | 'green' | 'yellow' | 'red';

const TONE_CLASS: Record<Tone, string> = {
  orange: 'bg-amber-bg text-amber',
  green: 'bg-up-bg text-up',
  yellow: 'bg-amber-bg text-amber',
  red: 'bg-down-bg text-down',
};

/**
 * The feed says what CHANGED. The per-condition breakdown and the running
 * "x of y met" count live in StrategyFocusPanel, so they are deliberately
 * not repeated here — a user reading both should not read the same sentence
 * twice.
 */
function describe(event: TimelineEvent): { label: string; tone: Tone; message: string } {
  switch (event.kind) {
    case 'wait_and_watch':
      return {
        label: 'WAIT AND WATCH',
        tone: 'orange',
        message: 'Your strategy started forming. Nothing is confirmed yet.',
      };
    case 'confirmed':
      return {
        label: 'SIDE IN FOCUS — CONFIRMED',
        tone: 'green',
        message: 'Every condition you defined is now met.',
      };
    case 'rejected':
      return {
        label: 'SETUP STEPPED BACK',
        tone: 'orange',
        message: `A condition your strategy had already met is no longer met — ${event.reason}. The setup is back to watching.`,
      };
    case 'milestone_1R':
      return {
        label: '1:1 REACHED — REVIEW',
        tone: 'yellow',
        message: 'Price moved 1x your risk. Your position is at one multiple of the risk you defined.',
      };
    case 'milestone_2R':
      return {
        label: '1:2 REACHED — REVIEW',
        tone: 'yellow',
        message: 'Price moved 2x your risk. Momentum has carried well beyond the risk you defined.',
      };
    case 'milestone_3R':
      return {
        label: '1:3 REACHED — REVIEW',
        tone: 'yellow',
        message: 'Price moved 3x your risk. The move is now three multiples of the risk you defined.',
      };
    case 'structure_break':
      return {
        label: 'RISK HIGH — STRUCTURE BREAKING',
        tone: 'orange',
        message: 'Market structure is shifting against your position. Stay safe and watch.',
      };
    case 'invalidation_reached':
      return {
        label: 'SETUP DID NOT WORK — INVALIDATION REACHED',
        tone: 'red',
        message: `${event.reason || 'The invalidation level you set was reached'}. The setup did not work as planned.`,
      };
    case 'projected_level_reached':
      return {
        label: 'PROJECTED LEVEL REACHED',
        tone: 'green',
        message: `${event.reason || 'The projected level you set was reached'}. Review your position.`,
      };
  }
}

function DirectionTag({ direction }: { direction: Direction }) {
  const isLong = direction === 'LONG';
  return (
    <span className={cn('font-semibold', isLong ? 'text-up' : 'text-down')}>
      {isLong ? 'Long' : 'Short'}
    </span>
  );
}

/**
 * The full contract identity, expiry included.
 *
 * The expiry was previously omitted, which left "NIFTY 24200 CE" ambiguous
 * across series — two different contracts with different premiums print the
 * same line. Every feed item names the instrument it is actually about, taken
 * from the engine's own record of the watch, so an event can never be read as
 * belonging to whatever the screen happens to be showing.
 */
function instrumentLabel(watch: TimelineWatch): string {
  return watchPairLabel(watch);
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

export function TimelineEventCard({ event, watch }: Props) {
  const { label, tone, message } = describe(event);
  // Direction is shown on every event EXCEPT wait-and-watch: before the user
  // has declared a position there is no direction to state, and inventing one
  // is the exact failure the Sentinel event contract exists to prevent.
  const showDirection = event.kind !== 'wait_and_watch' && watch.direction != null;

  return (
    <article className="flex animate-[fadeIn_200ms_ease-out] items-start gap-3 rounded-xl border border-border bg-card p-3.5">
      <span
        className={cn(
          'shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase leading-tight tracking-tightTrack',
          TONE_CLASS[tone],
        )}
      >
        {label}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-text">
          {instrumentLabel(watch)}
          {showDirection && watch.direction && (
            <>
              <span className="mx-1.5 text-faint">|</span>
              <DirectionTag direction={watch.direction} />
            </>
          )}
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{message}</p>
        <p className="mt-1 flex flex-wrap gap-x-3 text-[10.5px] text-faint">
          {event.rMultiple != null && <span>Progress: {event.rMultiple.toFixed(2)}R</span>}
          {event.occurrences > 1 && (
            <span>
              since {timeLabel(event.firstAt)} · {event.occurrences} checks
            </span>
          )}
        </p>
      </div>

      <time className="shrink-0 text-[10.5px] text-faint" dateTime={event.at}>
        {timeLabel(event.at)}
      </time>
    </article>
  );
}
