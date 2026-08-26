import { describe, expect, it } from 'vitest';
import { evaluateAutoTradeEligibility, type EligibilityInput } from './autotrade-eligibility';
import type { ExecutionProfileState } from './execution-state';

/** A profile that would pass everything, so each test can spoil exactly one thing. */
function profile(overrides: Partial<NonNullable<EligibilityInput['profile']>> = {}) {
  return {
    id: 'p1',
    name: 'sentinel-alpha-nifty-user',
    state: 'PAPER_ARMED' as ExecutionProfileState,
    accountScope: 'USER_PAPER' as const,
    autoTradeEnabled: false,
    symbol: 'NIFTY',
    lots: 1,
    minConfidence: 70,
    maxOpenPositions: 1,
    maxOrdersPerDay: 6,
    maxLossPerDay: 25_000,
    squareOffMinute: 910,
    ...overrides,
  };
}

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    hasSentinelEntitlement: true,
    entitlementReason: 'plan_grant',
    profile: profile(),
    accountAuthorized: true,
    accountReason: null,
    ...overrides,
  };
}

describe('AutoTrade eligibility', () => {
  it('Premium + admin-armed → available', () => {
    const result = evaluateAutoTradeEligibility(input());
    expect(result.eligible).toBe(true);
    expect(result.visible).toBe(true);
    expect(result.environment).toBe('PAPER');
    expect(result.reason).toBeNull();
  });

  it('Premium + NOT armed → unavailable, and the reason names the administrator', () => {
    // §14. The user must be told what is missing, not merely refused: "an
    // administrator must arm it" is actionable, "forbidden" is not.
    const result = evaluateAutoTradeEligibility(input({ profile: profile({ state: 'DISABLED' }) }));
    expect(result.eligible).toBe(false);
    expect(result.failedCheckId).toBe('admin-armed');
    expect(result.reason).toMatch(/administrator must arm/i);
  });

  it('Premium + not armed → not even VISIBLE', () => {
    // §3: AutoTrade must not be presented as an available capability to a user
    // no administrator has armed.
    expect(evaluateAutoTradeEligibility(input({ profile: profile({ state: 'DISARMED' }) })).visible).toBe(false);
  });

  it('non-Premium + armed → unavailable and invisible', () => {
    const result = evaluateAutoTradeEligibility(
      input({ hasSentinelEntitlement: false, entitlementReason: 'no_subscription' }),
    );
    expect(result.eligible).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.failedCheckId).toBe('sentinel-premium');
  });

  it('no profile → refused on that alone, without a wall of null-derived failures', () => {
    const result = evaluateAutoTradeEligibility(input({ profile: null }));
    expect(result.eligible).toBe(false);
    expect(result.failedCheckId).toBe('profile-exists');
    // Two checks, not seven. The remaining five are about a profile that does
    // not exist and would bury the one line that explains them all.
    expect(result.checks).toHaveLength(2);
  });

  it('refuses when the account gate says no, and passes its reason through verbatim', () => {
    const result = evaluateAutoTradeEligibility(
      input({ accountAuthorized: false, accountReason: 'Refused: user has not enabled agent paper trading.' }),
    );
    expect(result.failedCheckId).toBe('account-authorized');
    expect(result.reason).toMatch(/has not enabled agent paper trading/);
  });

  it('stays VISIBLE when an armed, entitled account fails a temporary condition', () => {
    // Hiding the control the moment a broker link lapses turns a fixable state
    // into a vanished feature — and the user cannot ask about what they cannot
    // see.
    const result = evaluateAutoTradeEligibility(input({ accountAuthorized: false, accountReason: 'consent revoked' }));
    expect(result.visible).toBe(true);
    expect(result.eligible).toBe(false);
  });

  describe('risk policy validity', () => {
    it('refuses a profile that could never place an order', () => {
      // `maxOrdersPerDay: 0` is not a safe profile; it is a broken one that
      // decides every pass and refuses every one, filling the intent table with
      // rejections that look like a policy working.
      const result = evaluateAutoTradeEligibility(input({ profile: profile({ maxOrdersPerDay: 0 }) }));
      expect(result.failedCheckId).toBe('policy-valid');
      expect(result.reason).toMatch(/maxOrdersPerDay/);
    });

    it('refuses a confidence floor Sentinel could never satisfy', () => {
      const result = evaluateAutoTradeEligibility(input({ profile: profile({ minConfidence: 40 }) }));
      expect(result.failedCheckId).toBe('policy-valid');
    });

    it('refuses a square-off outside the session', () => {
      // 16:00 IST never arrives while the session is open, so the profile would
      // hold positions past the close forever.
      const result = evaluateAutoTradeEligibility(input({ profile: profile({ squareOffMinute: 960 }) }));
      expect(result.failedCheckId).toBe('policy-valid');
    });
  });

  describe('the broker check applies to LIVE only', () => {
    it('does not require a broker connection for a paper profile', () => {
      // A paper user must never need a brokerage link — paper exists precisely
      // so they do not.
      const result = evaluateAutoTradeEligibility(input({ broker: null }));
      expect(result.eligible).toBe(true);
      expect(result.checks.map((c) => c.id)).not.toContain('broker-connected');
    });

    it('requires an unexpired broker credential for a live profile', () => {
      const live = input({
        profile: profile({ state: 'LIVE_ARMED', autoTradeEnabled: true }),
        broker: { connected: true, expired: true },
      });
      const result = evaluateAutoTradeEligibility(live);
      expect(result.environment).toBe('LIVE');
      expect(result.failedCheckId).toBe('broker-connected');
      expect(result.reason).toMatch(/expired/i);
    });

    it('refuses a live profile with no broker credential at all', () => {
      const result = evaluateAutoTradeEligibility(
        input({ profile: profile({ state: 'LIVE_RUNNING' }), broker: { connected: false, expired: false } }),
      );
      expect(result.failedCheckId).toBe('broker-connected');
    });
  });

  it('reports PAPER for a qualified profile — qualifying does not change the engine', () => {
    const result = evaluateAutoTradeEligibility(input({ profile: profile({ state: 'PAPER_QUALIFIED' }) }));
    expect(result.environment).toBe('PAPER');
    expect(result.eligible).toBe(true);
  });

  it('refuses a paused profile', () => {
    const result = evaluateAutoTradeEligibility(input({ profile: profile({ state: 'PAUSED' }) }));
    expect(result.eligible).toBe(false);
    expect(result.failedCheckId).toBe('admin-armed');
  });
});
