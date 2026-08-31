import { describe, expect, it } from 'vitest';
import { certifyStrategy, type UserStrategyRules } from './certification';
import { USER_CONDITIONS } from './conditions';

/**
 * The gate that decides whether a person's strategy may be traded by a machine.
 *
 * Most of these assertions are about REFUSAL, because that is where the danger
 * is. A gate that certifies too much fails silently and expensively; one that
 * certifies too little merely annoys someone.
 */

/** The v1 certified family — the strategy in the user's own workspace. */
const EMA7: UserStrategyRules = {
  timeframe: '5m',
  levels: ['ema7'],
  rules: [
    { id: 'rule_trend', name: 'price_above_ema7', condition: 'price_above_ema7', mandatory: true },
    { id: 'rule_ema_slope', name: 'ema7_rising', condition: 'ema7_rising', mandatory: true },
    { id: 'rule_reclaim', name: 'ema7_body_reclaim', condition: 'ema7_body_reclaim', mandatory: true },
    {
      id: 'rule_follow_through',
      name: 'reclaim_follow_through',
      condition: 'reclaim_retest_or_consolidation',
      mandatory: true,
    },
    { id: 'rule_volume_confirm', name: 'volume_confirm', condition: 'volume_above_20_period_avg', mandatory: false },
  ],
  entry: { long: 'after_reclaim_follow_through', short: null },
  riskManagement: { stopLoss: null, targets: [] },
};

const withRules = (rules: UserStrategyRules['rules']): UserStrategyRules => ({ ...EMA7, rules });

describe('the v1 certified family', () => {
  it('certifies ema7_bullish_reclaim as TRADABLE', () => {
    const cert = certifyStrategy(EMA7);
    expect(cert.status).toBe('TRADABLE');
    expect(cert.blockers).toEqual([]);
    expect(cert.interval).toBe('5m');
    expect(cert.direction).toBe('long');
    expect(cert.compiled).toHaveLength(5);
  });

  it('carries the minimum history its strictest condition needs', () => {
    // volume_above_20_period_avg needs 21 closed bars; the gate must demand
    // the maximum, not the average or the first.
    expect(certifyStrategy(EMA7).minBars).toBe(21);
  });

  it('records which conditions are mandatory, from the user’s own marking', () => {
    const cert = certifyStrategy(EMA7);
    expect(cert.compiled.filter((c) => c.mandatory)).toHaveLength(4);
    expect(cert.compiled.find((c) => !c.mandatory)?.condition).toBe('volume_above_20_period_avg');
  });
});

describe('refusals', () => {
  it('refuses an unknown condition and NAMES it', () => {
    const cert = certifyStrategy(withRules([{ condition: 'vwap_rejection_reclaim', mandatory: true }]));
    expect(cert.status).toBe('WATCH_ONLY');
    expect(cert.blockers[0].code).toBe('unsupported-condition');
    expect(cert.blockers[0].condition).toBe('vwap_rejection_reclaim');
  });

  it('refuses a deferred zone condition with the reason, not as "unknown"', () => {
    const cert = certifyStrategy(withRules([{ condition: 'zone_present', mandatory: true }]));
    expect(cert.blockers[0].code).toBe('deferred-condition');
    expect(cert.blockers[0].detail).toContain('zone model');
  });

  it('refuses the higher-timeframe zone condition for BOTH its reasons', () => {
    const cert = certifyStrategy(withRules([{ condition: 'zone_htf_aligned', mandatory: true }]));
    expect(cert.blockers[0].detail).toContain('higher-timeframe');
  });

  it('refuses an unsupported timeframe rather than substituting one', () => {
    const cert = certifyStrategy({ ...EMA7, timeframe: '3m' });
    expect(cert.status).toBe('WATCH_ONLY');
    expect(cert.blockers.some((b) => b.code === 'unsupported-timeframe')).toBe(true);
  });

  it('refuses a strategy with no timeframe — the agent must not choose one', () => {
    const cert = certifyStrategy({ ...EMA7, timeframe: null });
    expect(cert.blockers.some((b) => b.code === 'no-timeframe')).toBe(true);
  });

  it('refuses a strategy with no entry direction', () => {
    const cert = certifyStrategy({ ...EMA7, entry: { long: null, short: null } });
    expect(cert.blockers.some((b) => b.code === 'no-direction')).toBe(true);
  });

  it('refuses a short-side strategy in v1, explaining why', () => {
    const cert = certifyStrategy({ ...EMA7, entry: { long: null, short: 'breakdown' } });
    const blocker = cert.blockers.find((b) => b.code === 'no-direction')!;
    expect(blocker.detail).toContain('long-only');
    expect(cert.status).toBe('WATCH_ONLY');
  });

  it('refuses a two-sided strategy rather than picking a side', () => {
    const cert = certifyStrategy({ ...EMA7, entry: { long: 'a', short: 'b' } });
    expect(cert.blockers.some((b) => b.code === 'no-direction')).toBe(true);
  });

  it('refuses an empty strategy', () => {
    expect(certifyStrategy({ ...EMA7, rules: [] }).blockers.some((b) => b.code === 'no-conditions')).toBe(true);
  });

  it('refuses a strategy whose conditions are ALL optional', () => {
    // Nothing must be true before entering, so every pass would "satisfy" it.
    const cert = certifyStrategy(withRules([{ condition: 'price_above_ema7', mandatory: false }]));
    expect(cert.blockers.some((b) => b.code === 'no-mandatory-condition')).toBe(true);
  });

  it('refuses a rule that names no condition at all', () => {
    const cert = certifyStrategy(withRules([{ id: 'r1', mandatory: true }]));
    expect(cert.blockers[0].code).toBe('unsupported-condition');
  });
});

describe('the substitution rule', () => {
  it('NEVER silently maps an unsupported condition onto a similarly named rule', () => {
    // The three Phase 1 pairs whose names invite a fuzzy match and whose
    // behaviour is unrelated. The most dangerous is the last: a user's ENTRY
    // confirmation against a rule the agent uses to CLOSE positions.
    for (const condition of [
      'pullback_rejection_continuation',
      'level_flip_retest',
      'vwap_rejection_reclaim',
    ]) {
      const cert = certifyStrategy(withRules([{ condition, mandatory: true }]));
      expect(cert.status, condition).toBe('WATCH_ONLY');
      expect(cert.compiled, condition).toHaveLength(0);
    }
  });

  it('resolves by exact id — no aliasing, no normalisation beyond trimming', () => {
    expect(certifyStrategy(withRules([{ condition: 'price_above_ema_7', mandatory: true }])).status).toBe('WATCH_ONLY');
    expect(certifyStrategy(withRules([{ condition: 'PRICE_ABOVE_EMA7', mandatory: true }])).status).toBe('WATCH_ONLY');
    // Trimming is the one allowance, because the parser can emit padding.
    expect(certifyStrategy(withRules([{ condition: '  price_above_ema7  ', mandatory: true }])).compiled).toHaveLength(1);
  });

  it('reports EVERY declared condition, so nothing is silently ignored', () => {
    const cert = certifyStrategy(
      withRules([
        { condition: 'price_above_ema7', mandatory: true },
        { condition: 'zone_present', mandatory: true },
        { condition: 'made_up_condition', mandatory: true },
      ]),
    );
    expect(cert.declaredConditions).toEqual(['price_above_ema7', 'zone_present', 'made_up_condition']);
    expect(cert.blockers).toHaveLength(2);
    // The supported one still compiles — the report is per-condition, so a
    // user can see exactly how far their strategy is from tradable.
    expect(cert.compiled.map((c) => c.condition)).toEqual(['price_above_ema7']);
  });

  it('accumulates blockers rather than stopping at the first', () => {
    const cert = certifyStrategy({
      ...EMA7,
      timeframe: '3m',
      entry: { long: null, short: null },
      rules: [{ condition: 'zone_reaction', mandatory: true }],
    });
    const codes = cert.blockers.map((b) => b.code).sort();
    expect(codes).toEqual(['deferred-condition', 'no-direction', 'unsupported-timeframe']);
  });
});

describe('the registry is the parity claim', () => {
  it('certifies only conditions that exist in USER_CONDITIONS', () => {
    const cert = certifyStrategy(EMA7);
    for (const c of cert.compiled) {
      expect(USER_CONDITIONS[c.condition]).toBeDefined();
      expect(c.implementation.pythonSource).toMatch(/^evaluator\./);
    }
  });

  it('every registered condition declares its Python source and its divergences', () => {
    // Provenance is not decoration: it is the address drift is reported at.
    for (const [id, impl] of Object.entries(USER_CONDITIONS)) {
      expect(impl.id, id).toBe(id);
      expect(impl.pythonSource, id).toBeTruthy();
      expect(Array.isArray(impl.divergences), id).toBe(true);
      expect(impl.minBars, id).toBeGreaterThan(0);
    }
  });
});
