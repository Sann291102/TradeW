/**
 * Evaluate a certified user strategy against a candle series.
 *
 * One function, three possible answers, and the distinction between the last
 * two is the reason this is not a boolean:
 *
 *   ENTRY    every mandatory condition is met on a new closed bar.
 *   WAITING  the strategy was evaluated and its conditions are not all met.
 *   REFUSED  the strategy could not be evaluated — stale data, too little
 *            history, an uncertified strategy, a bar already seen.
 *
 * A refusal is NOT a "no". Collapsing them would let a dead market-data feed
 * read as "the setup is not there", which is the failure mode where an agent
 * looks calm and is in fact blind.
 *
 * ## Optional conditions
 *
 * The parser marks conditions mandatory or not, and the distinction is the
 * user's. Only mandatory conditions gate entry; optional ones are evaluated and
 * recorded so the trade journal can show that, say, the reclaim carried
 * above-average volume — without letting a missing volume feed block a strategy
 * whose author said volume was a nice-to-have.
 */
import type { Candle } from '@tradew/types';
import { gateBar, type BarGateReason } from './candle-policy';
import { createContext } from './conditions';
import type { Certification } from './certification';

export type UserStrategyVerdict = 'entry' | 'waiting' | 'refused';

export interface ConditionReport {
  ruleId: string;
  label: string;
  condition: string;
  mandatory: boolean;
  met: boolean;
  indeterminate: boolean;
  detail: string;
}

export interface UserStrategyEvaluation {
  verdict: UserStrategyVerdict;
  /** Machine-readable cause when refused. */
  refusal: BarGateReason | 'not-certified' | 'indeterminate-condition' | null;
  /** One sentence a person can act on. */
  reason: string;
  /** The bar this evaluation is about — the entry's idempotency anchor. */
  barTime: Date | null;
  interval: string | null;
  direction: 'long' | 'short' | null;
  conditions: ConditionReport[];
  /** Mandatory conditions still unmet, by condition id. */
  waitingOn: string[];
}

export interface EvaluateInput {
  certification: Certification;
  candles: Candle[];
  now: Date;
  lastEvaluatedBarTime: Date | null;
  maxBarAgeMs?: number;
}

function refuse(
  refusal: UserStrategyEvaluation['refusal'],
  reason: string,
  certification: Certification,
  barTime: Date | null = null,
): UserStrategyEvaluation {
  return {
    verdict: 'refused',
    refusal,
    reason,
    barTime,
    interval: certification.interval,
    direction: certification.direction,
    conditions: [],
    waitingOn: [],
  };
}

export function evaluateUserStrategy(input: EvaluateInput): UserStrategyEvaluation {
  const { certification, candles, now, lastEvaluatedBarTime } = input;

  if (certification.status !== 'TRADABLE' || !certification.interval) {
    return refuse('not-certified', certification.summary, certification);
  }

  const gate = gateBar({
    candles,
    interval: certification.interval,
    now,
    lastEvaluatedBarTime,
    minBars: certification.minBars,
    maxBarAgeMs: input.maxBarAgeMs,
  });

  if (!gate.eligible) {
    return refuse(gate.reason, gate.detail, certification, gate.bar?.timestamp ?? null);
  }

  const ctx = createContext(gate.candles, certification.interval);
  const reports: ConditionReport[] = certification.compiled.map((c) => {
    const outcome = c.implementation.evaluate(ctx);
    return {
      ruleId: c.ruleId,
      label: c.label,
      condition: c.condition,
      mandatory: c.mandatory,
      met: outcome.met,
      indeterminate: outcome.indeterminate === true,
      detail: outcome.detail,
    };
  });

  const barTime = gate.bar!.timestamp;

  // An indeterminate MANDATORY condition is a refusal, not a "not yet". The
  // strategy's author made it a requirement; an agent that cannot measure a
  // requirement has not established that the setup is absent.
  const blind = reports.filter((r) => r.mandatory && r.indeterminate);
  if (blind.length > 0) {
    return {
      ...refuse(
        'indeterminate-condition',
        `Cannot judge ${blind.map((b) => b.condition).join(', ')} — ${blind[0].detail}.`,
        certification,
        barTime,
      ),
      conditions: reports,
    };
  }

  const unmet = reports.filter((r) => r.mandatory && !r.met);
  if (unmet.length > 0) {
    return {
      verdict: 'waiting',
      refusal: null,
      reason: `${unmet.length} of ${reports.filter((r) => r.mandatory).length} required conditions not met — ${unmet[0].condition}: ${unmet[0].detail}.`,
      barTime,
      interval: certification.interval,
      direction: certification.direction,
      conditions: reports,
      waitingOn: unmet.map((r) => r.condition),
    };
  }

  const optionalMet = reports.filter((r) => !r.mandatory && r.met).length;
  const optionalTotal = reports.filter((r) => !r.mandatory).length;
  return {
    verdict: 'entry',
    refusal: null,
    reason:
      `Every required condition is met on the ${certification.interval} bar closing ${barTime.toISOString()}` +
      (optionalTotal > 0 ? ` (${optionalMet}/${optionalTotal} optional also met).` : '.'),
    barTime,
    interval: certification.interval,
    direction: certification.direction,
    conditions: reports,
    waitingOn: [],
  };
}
