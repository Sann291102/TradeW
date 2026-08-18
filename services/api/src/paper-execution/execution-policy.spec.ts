import { describe, expect, it } from 'vitest';
import { type PolicyInput, evaluatePolicy } from './execution-policy';

/** A profile and a market where everything is fine. Each test breaks one thing. */
const OK: PolicyInput = {
  enabled: true,
  environment: 'PAPER',
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

  it('refuses any environment that is not PAPER', () => {
    // `ExecutionEnvironment` has one member, so a non-PAPER value can only come
    // from outside this application. Refusing it is what makes "live money is
    // unrepresentable" true even against a hand-edited row.
    for (const environment of ['LIVE', 'live', 'PROD', '']) {
      const decision = fail({ environment });
      expect(decision.allowed).toBe(false);
      expect(decision.checks.find((c) => c.id === 'environment-paper')!.passed).toBe(false);
    }
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
