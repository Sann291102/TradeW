import { describe, expect, it } from 'vitest';
import {
  OMS_REJECTED,
  REJECT_CHECK_LABELS,
  SUBMISSION_RAISED,
  type PolicyInput,
  evaluatePolicy,
  rejectCheckLabel,
} from './execution-policy';

/** A profile and a market where everything is fine. Each test breaks one thing. */
const OK: PolicyInput = {
  enabled: true,
  environment: 'PAPER',
  authorizedEnvironment: 'PAPER',
  minConfidence: 70,
  maxOpenPositions: 1,
  maxOrdersPerDay: 6,
  maxLossPerDay: 25_000,
  squareOffMinute: 910, // 15:10
  confidence: 82,
  openPositions: 0,
  ordersToday: 0,
  realizedPnlToday: 0,
  minuteOfDay: 11 * 60 + 2,
  marketOpen: true,
  availableCash: 1_000_000,
  estimatedCost: 9_750,
};

const fail = (over: Partial<PolicyInput>) => evaluatePolicy({ ...OK, ...over });

describe('evaluatePolicy', () => {
  it('allows a well-formed intent and records every check that ran', () => {
    const decision = evaluatePolicy(OK);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.checks.every((c) => c.passed)).toBe(true);
    // A passing decision still carries its checks — "allowed" must be
    // inspectable, not just a boolean.
    expect(decision.checks.length).toBeGreaterThan(5);
  });

  it('refuses an environment the profile’s state does not authorize', () => {
    // The row says one thing, the state authorizes another. That can only come
    // from outside this application — a direct SQL edit, a restore from a
    // future schema — and refusing it is what keeps "live money is
    // unreachable" true even against a hand-edited row.
    //
    // Note the direction: `authorizedEnvironment` comes from
    // `environmentFor(state)`, so editing the COLUMN to LIVE does not grant
    // anything. It only makes the row inconsistent, and inconsistent is
    // refused.
    for (const environment of ['LIVE', 'live', 'PROD', '']) {
      const decision = fail({ environment, authorizedEnvironment: 'PAPER' });
      expect(decision.allowed).toBe(false);
      expect(decision.checks.find((c) => c.id === 'environment-authorized')!.passed).toBe(false);
    }
  });

  it('ADMITS a live row when the state authorizes live', () => {
    // The regression this check exists to prevent in the other direction.
    //
    // While this read `environment === 'PAPER'`, a correctly qualified,
    // correctly live-armed, deployment-enabled profile was refused HERE —
    // several gates before the adapter resolver was consulted — which made
    // ARM_LIVE a button that could never do anything. The end-to-end journey
    // harness caught it; this pins it.
    const decision = evaluatePolicy({ ...OK, environment: 'LIVE', authorizedEnvironment: 'LIVE' });
    expect(decision.allowed).toBe(true);
    expect(decision.checks.find((c) => c.id === 'environment-authorized')!.passed).toBe(true);
  });

  it('refuses a disabled profile', () => {
    expect(fail({ enabled: false }).allowed).toBe(false);
  });

  it('refuses when the market is closed', () => {
    expect(fail({ marketOpen: false }).allowed).toBe(false);
  });

  it('refuses an entry at or past the square-off minute', () => {
    expect(fail({ minuteOfDay: 910 }).allowed).toBe(false);
    expect(fail({ minuteOfDay: 925 }).allowed).toBe(false);
    // One minute before is still fine.
    expect(fail({ minuteOfDay: 909 }).allowed).toBe(true);
  });

  it('applies the profile confidence floor on top of Sentinel’s own gate', () => {
    expect(fail({ confidence: 69, minConfidence: 70 }).allowed).toBe(false);
    expect(fail({ confidence: 70, minConfidence: 70 }).allowed).toBe(true);
    // A profile may be STRICTER than Sentinel's 70, never looser.
    expect(fail({ confidence: 80, minConfidence: 85 }).allowed).toBe(false);
  });

  it('refuses once the open-position limit is reached', () => {
    expect(fail({ openPositions: 1, maxOpenPositions: 1 }).allowed).toBe(false);
    expect(fail({ openPositions: 1, maxOpenPositions: 2 }).allowed).toBe(true);
  });

  it('refuses once the daily order limit is reached', () => {
    expect(fail({ ordersToday: 6, maxOrdersPerDay: 6 }).allowed).toBe(false);
    expect(fail({ ordersToday: 5, maxOrdersPerDay: 6 }).allowed).toBe(true);
  });

  it('stops the day on a loss past the limit, and only on a LOSS', () => {
    expect(fail({ realizedPnlToday: -25_000 }).allowed).toBe(false);
    expect(fail({ realizedPnlToday: -30_000 }).allowed).toBe(false);
    expect(fail({ realizedPnlToday: -24_999 }).allowed).toBe(true);
    // The regression this pins: writing the check as `Math.abs(pnl) < max`
    // would halt trading after a GOOD day too.
    expect(fail({ realizedPnlToday: 40_000 }).allowed).toBe(true);
  });

  it('refuses an intent the account cannot fund', () => {
    expect(fail({ estimatedCost: 1_000_001, availableCash: 1_000_000 }).allowed).toBe(false);
    expect(fail({ estimatedCost: 1_000_000, availableCash: 1_000_000 }).allowed).toBe(true);
  });

  it('reports the first failing check as the reason, in plain language', () => {
    const decision = fail({ confidence: 40 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('40%');
    expect(decision.reason).toContain('70%');
  });

  it('runs every check even when an early one fails, so the record is complete', () => {
    const decision = evaluatePolicy({
      ...OK,
      enabled: false,
      marketOpen: false,
      confidence: 10,
      openPositions: 99,
    });
    expect(decision.allowed).toBe(false);
    // An operator debugging a refusal needs all of them, not just the first.
    expect(decision.checks.filter((c) => !c.passed).length).toBeGreaterThanOrEqual(4);
  });
});

/**
 * The refusal has to survive being stored.
 *
 * `reason` is a sentence with live numbers in it, so two refusals for the same
 * cause are different strings and counting them is impossible. `failedCheckId`
 * is the same fact in a form that groups — it is what lands on
 * `ExecutionIntent.rejectCheckId` and what the console's breakdown counts. If
 * these drift, an operator's answer to "why did nothing trade today?" is wrong
 * in a way that looks plausible.
 */
describe('the refusal is recorded in a countable form', () => {
  it('names the FIRST failing check, not merely some failing check', () => {
    // Two gates broken at once. Order of evaluation decides which is reported,
    // and it must be the same one `reason` describes — a breakdown that counts
    // a different gate than the sentence explains is worse than no breakdown.
    const decision = fail({ marketOpen: false, confidence: 10 });
    expect(decision.allowed).toBe(false);
    expect(decision.failedCheckId).toBe('market-open');
    expect(decision.reason).toBe(decision.checks.find((c) => c.id === 'market-open')!.detail);
  });

  it('is null when the intent is allowed', () => {
    expect(evaluatePolicy(OK).failedCheckId).toBeNull();
  });

  it('reports each gate under its own id', () => {
    const cases: Array<[Partial<PolicyInput>, string]> = [
      [{ enabled: false }, 'profile-enabled'],
      [{ environment: 'LIVE' }, 'environment-authorized'],
      [{ marketOpen: false }, 'market-open'],
      [{ minuteOfDay: 15 * 60 + 20 }, 'before-square-off'],
      [{ confidence: 12 }, 'confidence-floor'],
      [{ openPositions: 1 }, 'max-open-positions'],
      [{ ordersToday: 6 }, 'max-orders-per-day'],
      [{ realizedPnlToday: -25_001 }, 'daily-loss-limit'],
      [{ availableCash: 10 }, 'affordable'],
    ];
    for (const [broken, id] of cases) {
      expect(fail(broken).failedCheckId).toBe(id);
    }
  });

  it('has a human label for every id it can emit, including the non-policy stops', () => {
    // The console groups by id and renders the label. An id with no label would
    // surface as an unlabelled bar — the kind of gap nobody notices until an
    // operator is staring at it during an incident.
    for (const check of evaluatePolicy({ ...OK, enabled: false }).checks) {
      expect(REJECT_CHECK_LABELS[check.id]).toBeTruthy();
      expect(check.label).toBe(REJECT_CHECK_LABELS[check.id]);
    }
    expect(rejectCheckLabel(SUBMISSION_RAISED)).toBeTruthy();
    expect(rejectCheckLabel(OMS_REJECTED)).toBeTruthy();
  });

  it('falls back to the id itself rather than losing an unknown refusal', () => {
    // Rows written before a check was renamed still have to render as
    // something. Showing the raw id is worse than a label and far better than
    // dropping the bucket.
    expect(rejectCheckLabel('some-future-check')).toBe('some-future-check');
    expect(rejectCheckLabel(null)).toBe('Not recorded');
  });
});
