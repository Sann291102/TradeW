/**
 * The tradability gate: may this user strategy be traded autonomously?
 *
 * Deny by default. A strategy is TRADABLE only when every single one of its
 * conditions has a TypeScript implementation that has been verified against the
 * Python original, its timeframe is one the snapshot can actually be built on,
 * and it declares a direction. Anything else is WATCH_ONLY, and the report says
 * exactly which condition stopped it and why.
 *
 * ## The rule this file exists to enforce
 *
 * NEVER SILENTLY SUBSTITUTE A SIMILARLY NAMED RULE. Phase 1 found three pairs
 * whose names invite exactly that and whose behaviour is unrelated — most
 * sharply `vwap_rejection_reclaim`, a user's ENTRY confirmation, against
 * `vwap_reclaimed_against`, a rule the agent uses to CLOSE positions. A fuzzy
 * or nearest-match resolver would have wired one to the other. So resolution is
 * exact-id lookup in `USER_CONDITIONS` and nothing else: no aliases, no
 * normalisation beyond trimming, no fallback.
 *
 * ## What "verified" means
 *
 * Membership in `USER_CONDITIONS` IS the parity claim. A condition earns its
 * place there by having a port whose `met` matches the Python evaluator's
 * boolean across the replay corpus (`replay-parity.spec.ts`). Adding an entry
 * without that evidence is the one way to break this gate, which is why the
 * registry and the parity suite live beside each other.
 */
import { DEFERRED_CONDITIONS, USER_CONDITIONS, type UserCondition } from './conditions';
import { SUPPORTED_INTERVALS, resolveInterval } from './candle-policy';
import type { CandleInterval } from '@tradew/types';

/** The `rules` JSON column on `UserStrategy`, as the Python parser writes it. */
export interface UserStrategyRules {
  timeframe?: string | null;
  levels?: string[];
  rules?: Array<{
    id?: string;
    name?: string;
    condition?: string;
    mandatory?: boolean;
    description?: string;
  }>;
  entry?: { long?: string | null; short?: string | null };
  riskManagement?: { stopLoss?: string | null; targets?: string[] };
}

export type CertificationStatus = 'TRADABLE' | 'WATCH_ONLY';

export type BlockerCode =
  | 'no-conditions'
  | 'unsupported-condition'
  | 'deferred-condition'
  | 'unsupported-timeframe'
  | 'no-timeframe'
  | 'no-direction'
  | 'no-mandatory-condition';

export interface CertificationBlocker {
  code: BlockerCode;
  /** The condition id this is about, when it is about one. */
  condition?: string;
  detail: string;
}

export interface CompiledCondition {
  /** The rule id from the user's strategy, for reporting against their own labels. */
  ruleId: string;
  label: string;
  condition: string;
  mandatory: boolean;
  implementation: UserCondition;
}

export interface Certification {
  status: CertificationStatus;
  /** Resolved only when the timeframe is supported. */
  interval: CandleInterval | null;
  /** Closed bars needed before any condition can be judged. */
  minBars: number;
  /** 'long' — V1 supports long-only strategies. See `direction` below. */
  direction: 'long' | 'short' | null;
  compiled: CompiledCondition[];
  blockers: CertificationBlocker[];
  /** Every condition the strategy names, supported or not — nothing is dropped. */
  declaredConditions: string[];
  /** One-line summary for the console and the user-facing surface. */
  summary: string;
}

/**
 * Direction is read from the parser's `entry`, never inferred from the rules.
 *
 * A strategy that declares neither side is refused rather than defaulted to
 * long: the agent would otherwise buy calls on a rule set the author wrote to
 * describe a short. V1 supports long only, because the one certified family
 * (`ema7_bullish_reclaim`) is long-only by construction and there is no bearish
 * counterpart to its reclaim primitives — see `findBullishReclaims`.
 */
function readDirection(rules: UserStrategyRules): { direction: 'long' | 'short' | null; blocker: CertificationBlocker | null } {
  const long = rules.entry?.long ?? null;
  const short = rules.entry?.short ?? null;
  if (long && !short) return { direction: 'long', blocker: null };
  if (short && !long) {
    return {
      direction: 'short',
      blocker: {
        code: 'no-direction',
        detail: 'Short-side strategies are not certified in v1 — the reclaim primitives are long-only by construction.',
      },
    };
  }
  if (long && short) {
    return {
      direction: null,
      blocker: {
        code: 'no-direction',
        detail: 'This strategy declares both a long and a short entry; v1 certifies single-direction strategies only.',
      },
    };
  }
  return {
    direction: null,
    blocker: {
      code: 'no-direction',
      detail: 'This strategy declares no entry direction, so there is nothing for an agent to act on.',
    },
  };
}

export function certifyStrategy(rules: UserStrategyRules): Certification {
  const blockers: CertificationBlocker[] = [];
  const compiled: CompiledCondition[] = [];
  const declared: string[] = [];

  const interval = resolveInterval(rules.timeframe);
  if (!rules.timeframe) {
    blockers.push({
      code: 'no-timeframe',
      detail: 'This strategy declares no timeframe, and an agent must not choose one for it.',
    });
  } else if (!interval) {
    blockers.push({
      code: 'unsupported-timeframe',
      detail: `Timeframe "${rules.timeframe}" is not supported. Supported: ${SUPPORTED_INTERVALS.join(', ')}.`,
    });
  }

  const declaredRules = rules.rules ?? [];
  if (declaredRules.length === 0) {
    blockers.push({ code: 'no-conditions', detail: 'This strategy has no rules to evaluate.' });
  }

  for (const rule of declaredRules) {
    const condition = (rule.condition ?? '').trim();
    declared.push(condition);

    if (condition in DEFERRED_CONDITIONS) {
      blockers.push({
        code: 'deferred-condition',
        condition,
        detail: DEFERRED_CONDITIONS[condition],
      });
      continue;
    }

    const implementation = USER_CONDITIONS[condition];
    if (!implementation) {
      blockers.push({
        code: 'unsupported-condition',
        condition,
        detail: condition
          ? `"${condition}" has no verified TypeScript implementation, so it cannot be traded autonomously.`
          : 'A rule declares no condition at all.',
      });
      continue;
    }

    compiled.push({
      ruleId: rule.id ?? condition,
      label: rule.name ?? condition,
      condition,
      mandatory: rule.mandatory === true,
      implementation,
    });
  }

  // A strategy of nothing but optional conditions has no entry trigger: every
  // pass would be "satisfied" the moment the optional ones happened to align.
  if (compiled.length > 0 && !compiled.some((c) => c.mandatory)) {
    blockers.push({
      code: 'no-mandatory-condition',
      detail: 'Every condition in this strategy is optional, so there is nothing that must be true before entering.',
    });
  }

  const { direction, blocker: directionBlocker } = readDirection(rules);
  if (directionBlocker) blockers.push(directionBlocker);

  const minBars = compiled.reduce((max, c) => Math.max(max, c.implementation.minBars), 0);
  const status: CertificationStatus = blockers.length === 0 ? 'TRADABLE' : 'WATCH_ONLY';

  const summary =
    status === 'TRADABLE'
      ? `All ${compiled.length} conditions are supported on ${interval}. Eligible for autonomous paper trading.`
      : `Watch-only: ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} — ${blockers
          .map((b) => b.condition ?? b.code)
          .join(', ')}.`;

  return {
    status,
    interval: status === 'TRADABLE' ? interval : interval,
    minBars,
    direction: status === 'TRADABLE' ? direction : direction,
    compiled,
    blockers,
    declaredConditions: declared,
    summary,
  };
}
