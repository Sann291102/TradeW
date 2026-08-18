import type {
  ParsedStrategy,
  PositionDirection,
  UserStrategy,
  WatchSession,
  WatchState,
} from './strategyApi';
import { watchPairLabel } from './watchState';

/**
 * Pure, framework-free helpers for the Sentinel strategy/watch workspace.
 *
 * Everything here is a function of data the API already returned — no
 * network, no DOM, no React — so the parts with real edge cases (R-multiple
 * arithmetic, position validation, state grouping) are unit-testable. The
 * components import from here and only render.
 *
 * ## Vocabulary
 *
 * The database columns are `stopPrice`/`targetPrice`, and the API keeps those
 * names. The UI does not: Sentinel's compliance layer
 * (services/sentinel-py/app/notify/compliance.py) rejects "stop-loss"/"target"
 * wording outright, so the labels here say "invalidation level" and
 * "projected level" — the same words the notifications use. This module is
 * where the two vocabularies meet, and it is the only place they should.
 */

export type StateTone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning';

export interface WatchStateMeta {
  label: string;
  tone: StateTone;
  /** One line of plain language: what this state means for the user. */
  blurb: string;
}

/**
 * IDLE → FORMING → CONFIRMED are what the sweep loop sets; IN_TRADE and
 * EXITED are set by the user declaring a position opened or closed. Mirrors
 * `WatchState` in app/watch/state_machine.py.
 */
export const WATCH_STATE_META: Record<WatchState, WatchStateMeta> = {
  IDLE: {
    label: 'Idle',
    tone: 'neutral',
    blurb: 'Watching. None of your conditions have been met yet.',
  },
  FORMING: {
    label: 'Forming',
    tone: 'warning',
    blurb: 'Some of your conditions are met. Nothing is confirmed.',
  },
  CONFIRMED: {
    label: 'Confirmed',
    tone: 'brand',
    blurb: 'Every condition you defined is now met.',
  },
  IN_TRADE: {
    label: 'In trade',
    tone: 'positive',
    blurb: 'You marked a position taken. Sentinel is tracking it against your own levels.',
  },
  EXITED: {
    label: 'Closed',
    tone: 'neutral',
    blurb: 'This watch is finished.',
  },
};

/**
 * How the user's own watch is named back to them, matching
 * `instrument_label()` in app/notify/dispatcher.py so a notification and the
 * panel refer to the same thing in the same words. Both were widened to the
 * PAIR on 2026-08-18, together, so they still agree.
 */
export function instrumentLabel(
  watch: Pick<WatchSession, 'symbol' | 'strike' | 'optionType' | 'expiry'> & Partial<Pick<WatchSession, 'ce' | 'pe'>>,
): string {
  // Both legs, via the one adapter that knows how a watch records them. This
  // used to print the focused leg alone, which named half of a pair watch.
  return watchPairLabel(watch);
}

/** `2026-08-28` → `28 Aug`. Returns the input unchanged if it isn't ISO. */
export function formatExpiry(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? '';
  const [, month, day] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = months[Number(month) - 1];
  return name ? `${Number(day)} ${name}` : iso;
}

/**
 * A first-draft name for a strategy, from the text the user typed. They can
 * always overwrite it — this exists so naming is not a blocking step between
 * writing a strategy and saving it.
 */
export function suggestStrategyName(rawText: string, maxLength = 48): string {
  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return capitalize(cleaned);
  // Cut on a word boundary so the suggestion never ends mid-word.
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${capitalize(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut)}…`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface RuleCounts {
  mandatory: number;
  optional: number;
  total: number;
}

export function ruleCounts(parsed: ParsedStrategy | null | undefined): RuleCounts {
  const rules = parsed?.rules ?? [];
  const mandatory = rules.filter((r) => r.mandatory).length;
  return { mandatory, optional: rules.length - mandatory, total: rules.length };
}

/**
 * Whether this strategy can ever confirm.
 *
 * A strategy the parser found no rules in is saved anyway (the API allows it,
 * and the raw text is kept), but it will sit at IDLE forever because
 * `next_state()` needs at least one mandatory condition to advance. Saying so
 * up front is the difference between an empty watch and a silent one.
 */
export function isWatchable(parsed: ParsedStrategy | null | undefined): boolean {
  return ruleCounts(parsed).mandatory > 0;
}

/**
 * Progress in units of the risk the USER defined, mirroring `r_multiple()` in
 * app/intrade/monitor.py exactly — same inputs, same result, so the panel and
 * the notification never disagree about what 1R means.
 *
 * null when risk is zero: an entry equal to the invalidation level has no
 * scale to measure against, and dividing by it would render as an infinite R
 * that reads as spectacular success.
 */
export function rMultiple(
  entry: number,
  current: number,
  invalidation: number,
  direction: PositionDirection,
): number | null {
  const risk = Math.abs(entry - invalidation);
  if (risk === 0) return null;
  const reward = direction === 'LONG' ? current - entry : entry - current;
  return reward / risk;
}

/** `+1.83R` / `−0.40R` / `—`. Uses a real minus sign, like the rest of the app. */
export function formatRMultiple(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return '—';
  const sign = r > 0 ? '+' : r < 0 ? '−' : '';
  return `${sign}${Math.abs(r).toFixed(2)}R`;
}

/** Tone for an R-multiple: gains/losses are the only thing up/down colors mean. */
export function rMultipleTone(r: number | null): StateTone {
  if (r === null || !Number.isFinite(r) || r === 0) return 'neutral';
  return r > 0 ? 'positive' : 'negative';
}

export interface PositionSnapshot {
  /** null until a live price for this instrument is available. */
  currentPrice: number | null;
  r: number | null;
  /** Absolute move per unit, in the direction of the position. */
  move: number | null;
  reached: string[];
  next: string | null;
}

const MILESTONES = ['1R', '2R', '3R'] as const;

/** The next milestone the position has not yet reached, or null past 3R. */
export function nextMilestone(reached: string[]): string | null {
  return MILESTONES.find((m) => !reached.includes(m)) ?? null;
}

/**
 * Everything the in-trade card shows, derived in one place so the card is a
 * pure render. Returns nulls rather than guesses when the watch has no
 * declared position or no live price yet.
 */
export function positionSnapshot(watch: WatchSession, currentPrice: number | null): PositionSnapshot {
  const { entryPrice, stopPrice, direction, reachedMilestones } = watch;
  const reached = reachedMilestones ?? [];
  if (entryPrice === null || stopPrice === null || direction === null || currentPrice === null) {
    return { currentPrice, r: null, move: null, reached, next: nextMilestone(reached) };
  }
  const move = direction === 'LONG' ? currentPrice - entryPrice : entryPrice - currentPrice;
  return {
    currentPrice,
    r: rMultiple(entryPrice, currentPrice, stopPrice, direction),
    move,
    reached,
    next: nextMilestone(reached),
  };
}

export interface GroupedWatches {
  /** Pre-position watches, most recently updated first. */
  watching: WatchSession[];
  inTrade: WatchSession[];
  closed: WatchSession[];
}

/**
 * Splits watches into the three panels the workspace shows. Sorted by
 * `updatedAt` descending inside each group, so whatever moved most recently
 * is what the user's eye lands on.
 */
export function groupWatches(watches: WatchSession[]): GroupedWatches {
  const byRecency = [...watches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    watching: byRecency.filter((w) => w.state === 'IDLE' || w.state === 'FORMING' || w.state === 'CONFIRMED'),
    inTrade: byRecency.filter((w) => w.state === 'IN_TRADE'),
    closed: byRecency.filter((w) => w.state === 'EXITED'),
  };
}

/** Sort order for the state column: the states that need attention first. */
const STATE_URGENCY: Record<WatchState, number> = {
  CONFIRMED: 0,
  FORMING: 1,
  IN_TRADE: 2,
  IDLE: 3,
  EXITED: 4,
};

export function byUrgency(a: WatchSession, b: WatchSession): number {
  return STATE_URGENCY[a.state] - STATE_URGENCY[b.state] || b.updatedAt.localeCompare(a.updatedAt);
}

export interface PositionValidation {
  /** Blocking: the request would be rejected or is meaningless. */
  errors: string[];
  /**
   * Non-blocking: the numbers are self-consistent but look like a slip. These
   * are the user's own levels, so a warning names the consequence and lets
   * them proceed.
   */
  warnings: string[];
  valid: boolean;
}

/**
 * Checks a position the user is about to declare.
 *
 * The only hard rule the API enforces is entry ≠ invalidation (a zero risk has
 * no scale for R-multiples). This adds the arithmetic checks a form can make
 * before a round trip, and warns — rather than blocks — when an invalidation
 * level sits on the wrong side of the entry: that is the user's own number to
 * set, but a long invalidated above its entry is already invalid the moment it
 * is saved, and silently accepting it would fire "invalidation reached" on the
 * next sweep with no explanation.
 */
export function validatePosition(input: {
  entryPrice: number | null;
  invalidationPrice: number | null;
  projectedPrice: number | null;
  direction: PositionDirection;
}): PositionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { entryPrice, invalidationPrice, projectedPrice, direction } = input;

  if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    errors.push('Enter the price you took the position at.');
  }
  if (invalidationPrice === null || !Number.isFinite(invalidationPrice) || invalidationPrice <= 0) {
    errors.push('Enter the price at which you would consider this idea wrong.');
  }
  if (
    entryPrice !== null &&
    invalidationPrice !== null &&
    Number.isFinite(entryPrice) &&
    Number.isFinite(invalidationPrice) &&
    entryPrice === invalidationPrice
  ) {
    errors.push('Your entry and invalidation level are the same, which leaves no risk to measure progress against.');
  }
  if (projectedPrice !== null && (!Number.isFinite(projectedPrice) || projectedPrice <= 0)) {
    errors.push('The projected level must be a price, or left blank.');
  }

  if (errors.length === 0 && entryPrice !== null && invalidationPrice !== null) {
    const invalidationOnWrongSide =
      direction === 'LONG' ? invalidationPrice > entryPrice : invalidationPrice < entryPrice;
    if (invalidationOnWrongSide) {
      warnings.push(
        direction === 'LONG'
          ? 'Your invalidation level is above your entry, so this long position is already invalidated.'
          : 'Your invalidation level is below your entry, so this short position is already invalidated.',
      );
    }
    if (projectedPrice !== null) {
      const projectionOnWrongSide =
        direction === 'LONG' ? projectedPrice < entryPrice : projectedPrice > entryPrice;
      if (projectionOnWrongSide) {
        warnings.push('Your projected level is behind your entry, so it would be reported as reached immediately.');
      }
    }
  }

  return { errors, warnings, valid: errors.length === 0 };
}

/**
 * Planned risk:reward from the user's own three numbers, e.g. `1 : 2.5`.
 * null when there is no projected level or no risk to compare it against.
 */
export function plannedRatio(
  entryPrice: number | null,
  invalidationPrice: number | null,
  projectedPrice: number | null,
): number | null {
  if (entryPrice === null || invalidationPrice === null || projectedPrice === null) return null;
  const risk = Math.abs(entryPrice - invalidationPrice);
  if (risk === 0) return null;
  return Math.abs(projectedPrice - entryPrice) / risk;
}

/** Strategies a watch can be created from — archived ones cannot. */
export function selectableStrategies(strategies: UserStrategy[]): UserStrategy[] {
  return strategies.filter((s) => s.status !== 'archived');
}

/**
 * A paused strategy's watches are skipped by the sweep loop (`list_active_watches`
 * joins on `status = 'active'`), so a watch under a paused strategy is not
 * being evaluated even though its state still reads IDLE/FORMING.
 */
export function isDormant(watch: WatchSession, strategies: UserStrategy[]): boolean {
  if (watch.state === 'EXITED') return false;
  const strategy = strategies.find((s) => s.id === watch.strategyId);
  return strategy !== undefined && strategy.status !== 'active';
}
