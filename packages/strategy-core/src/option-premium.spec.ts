import { describe, expect, it } from 'vitest';
import {
  DECAY_DAYS,
  MIN_STRIKE_OI,
  optionSideFor,
  projectPremium,
  selectStrike,
  translateToPremium,
  type OptionQuote,
} from './option-premium';

/**
 * Shaped from the real NIFTY chain read off the running bridge on 2026-09-10:
 * spot 23446.6, ATM 23450 CE at 154.55 with delta 0.5216 and OI 2,364,570.
 */
const atmCall = (over: Partial<OptionQuote> = {}): OptionQuote => ({
  strike: 23450,
  optionType: 'CE',
  ltp: 154.55,
  oi: 2_364_570,
  volume: 100_000,
  iv: 12,
  delta: 0.5216,
  gamma: 0.0004,
  theta: 5,
  bid: 0,
  ask: 0,
  ...over,
});

const SPOT = 23446.6;

describe('side selection', () => {
  it('expresses a bearish index read as a long PUT, never a short', () => {
    // Long options only: risk is capped at the premium.
    expect(optionSideFor('long')).toBe('CE');
    expect(optionSideFor('short')).toBe('PE');
  });
});

describe('premium projection', () => {
  it('moves with delta and curves with gamma', () => {
    const q = atmCall({ theta: 0 });
    const up = projectPremium(q, SPOT, SPOT + 100, 0);
    const down = projectPremium(q, SPOT, SPOT - 100, 0);

    // Delta alone would make these symmetric around the entry. Gamma is what
    // makes a long option's reward convex and its risk concave, and using
    // delta alone would be materially wrong over a 3R move.
    const upMove = up - q.ltp;
    const downMove = q.ltp - down;
    expect(upMove).toBeGreaterThan(downMove);
  });

  it('charges theta against the projection', () => {
    const q = atmCall({ theta: 5 });
    const withDecay = projectPremium(q, SPOT, SPOT + 100, 1);
    const withoutDecay = projectPremium(q, SPOT, SPOT + 100, 0);
    expect(withoutDecay - withDecay).toBeCloseTo(5, 2);
  });

  it('never returns a negative premium', () => {
    const q = atmCall();
    expect(projectPremium(q, SPOT, SPOT - 5000, 1)).toBe(0);
  });

  it('is MONOTONIC — a long call can never gain as the index falls', () => {
    // The flaw this replaced: the raw `δ·ΔP + ½γ·ΔP²` expansion is only valid
    // near the expansion point, and for a large adverse move the quadratic
    // dominates. With real chain greeks (δ 0.52, γ 0.0004) a 5,000-point fall
    // projected the premium UP from 154 to 2,541 — a catastrophic move
    // reported as a windfall. Sizing risk off that is worse than no model.
    const q = atmCall({ theta: 0 });
    let previous = Number.POSITIVE_INFINITY;
    for (const drop of [0, 100, 300, 1000, 2500, 5000]) {
      const premium = projectPremium(q, SPOT, SPOT - drop, 0);
      expect(premium).toBeLessThanOrEqual(previous);
      previous = premium;
    }
  });

  it('is monotonic for a put as the index rises', () => {
    const put = atmCall({ optionType: 'PE', delta: -0.48, theta: 0 });
    let previous = Number.POSITIVE_INFINITY;
    for (const rise of [0, 100, 300, 1000, 2500, 5000]) {
      const premium = projectPremium(put, SPOT, SPOT + rise, 0);
      expect(premium).toBeLessThanOrEqual(previous);
      previous = premium;
    }
  });
});

describe('strike selection', () => {
  const chain = (): OptionQuote[] => [
    atmCall({ strike: 23300, ltp: 258.1, delta: 0.6632, oi: 568_230 }),
    atmCall({ strike: 23400, ltp: 187.65, delta: 0.5729, oi: 1_826_955 }),
    atmCall({ strike: 23450, ltp: 154.55, delta: 0.5216, oi: 2_364_570 }),
    atmCall({ strike: 23500, ltp: 127.05, delta: 0.4663, oi: 8_068_840 }),
    atmCall({ strike: 23450, optionType: 'PE', ltp: 150, delta: -0.48, oi: 900_000 }),
  ];

  it('picks the nearest-the-money strike of the right side', () => {
    const picked = selectStrike({ spot: SPOT, direction: 'long', quotes: chain() });
    expect(picked?.strike).toBe(23450);
    expect(picked?.optionType).toBe('CE');
  });

  it('picks a PUT for a short', () => {
    const picked = selectStrike({ spot: SPOT, direction: 'short', quotes: chain() });
    expect(picked?.optionType).toBe('PE');
  });

  it('refuses an illiquid strike rather than trading it', () => {
    const illiquid = chain().map((q) => ({ ...q, oi: MIN_STRIKE_OI - 1 }));
    expect(selectStrike({ spot: SPOT, direction: 'long', quotes: illiquid })).toBeNull();
  });

  it('refuses a strike with no traded premium or no delta', () => {
    expect(
      selectStrike({ spot: SPOT, direction: 'long', quotes: chain().map((q) => ({ ...q, ltp: 0 })) }),
    ).toBeNull();
    expect(
      selectStrike({ spot: SPOT, direction: 'long', quotes: chain().map((q) => ({ ...q, delta: 0 })) }),
    ).toBeNull();
  });

  it('will not reach far out of the money for a cheaper contract', () => {
    // A far OTM strike is mostly a volatility bet in a directional costume.
    const far = [atmCall({ strike: 26000, ltp: 2, delta: 0.02, oi: 5_000_000 })];
    expect(selectStrike({ spot: SPOT, direction: 'long', quotes: far })).toBeNull();
  });
});

describe('the premium 1:3 floor', () => {
  /** A 3R index plan: entry 23446.6, stop −100, target +300. */
  const indexPlan = {
    direction: 'long' as const,
    spot: SPOT,
    indexEntry: SPOT,
    indexStop: SPOT - 100,
    indexTarget: SPOT + 300,
    indexFirstReward: SPOT + 100,
  };

  it('accepts a contract that genuinely pays 1:3 and records the translation', () => {
    // Low theta, so the projection is dominated by delta and gamma.
    const out = translateToPremium({ ...indexPlan, quote: atmCall({ theta: 0.5 }) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.plan.premiumRR).toBeGreaterThanOrEqual(3);
    expect(out.plan.riskPerUnit).toBeGreaterThan(0);
    expect(out.plan.strike).toBe(23450);
    // Both plans are kept so the journal can SHOW the translation.
    expect(out.plan.rationale.join(' ')).toContain(String(out.plan.stopPremium));
    expect(out.plan.rationale.join(' ')).toContain(String(out.plan.targetPremium));
  });

  it('REFUSES a 3R index setup whose contract cannot carry it', () => {
    // The entire point of this file. Heavy theta eats the reward while the
    // structural plan is untouched and still perfectly 1:3.
    const out = translateToPremium({ ...indexPlan, quote: atmCall({ theta: 40 }) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('premium-rr-below-floor');
    expect(out.detail).toContain('the structure is sound, the instrument cannot carry it');
  });

  it('never adjusts a level to make the ratio pass', () => {
    // Across a sweep of thetas, either the contract clears 3:1 on its own or
    // it is refused. The index levels are inputs and are never rewritten.
    for (const theta of [0, 1, 5, 10, 20, 40, 80]) {
      const out = translateToPremium({ ...indexPlan, quote: atmCall({ theta }) });
      if (out.ok) {
        expect(out.plan.premiumRR).toBeGreaterThanOrEqual(3);
        // Entry premium is the chain's price, untouched.
        expect(out.plan.entryPremium).toBe(154.55);
      } else {
        expect(out.reason).toBe('premium-rr-below-floor');
      }
    }
  });

  it('refuses a zero delta rather than assuming a translation', () => {
    const out = translateToPremium({ ...indexPlan, quote: atmCall({ delta: 0 }) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('delta-unusable');
  });

  it('refuses a contract with no traded premium', () => {
    const out = translateToPremium({ ...indexPlan, quote: atmCall({ ltp: 0 }) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('premium-unusable');
  });

  it('refuses when the projected stop is not below the entry premium', () => {
    // A stop that projects to MORE than was paid is a non-risk, and dividing
    // by it would produce a spectacular and meaningless ratio.
    const out = translateToPremium({
      ...indexPlan,
      indexStop: SPOT + 50, // stop above entry: nonsensical, must not size off it
      quote: atmCall({ theta: 0 }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('premium-stop-non-positive');
  });

  it('records the first-reward level in premium space too', () => {
    const out = translateToPremium({ ...indexPlan, quote: atmCall({ theta: 0.5 }) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The ratchet arms on the premium the account actually holds.
    expect(out.plan.firstRewardPremium).toBeGreaterThan(out.plan.entryPremium);
    expect(out.plan.firstRewardPremium).toBeLessThan(out.plan.targetPremium);
  });

  it('charges a full day of theta by default, which is the conservative side', () => {
    expect(DECAY_DAYS).toBe(1);
    const strict = translateToPremium({ ...indexPlan, quote: atmCall({ theta: 8 }) });
    const generous = translateToPremium({ ...indexPlan, quote: atmCall({ theta: 8 }), decayDays: 0 });
    if (strict.ok && generous.ok) {
      expect(generous.plan.premiumRR).toBeGreaterThanOrEqual(strict.plan.premiumRR);
    }
  });
});

describe('shorts translate through puts', () => {
  it('projects a put gaining as the index falls', () => {
    const put = atmCall({ optionType: 'PE', ltp: 150, delta: -0.48, gamma: 0.0004, theta: 0.5 });
    const out = translateToPremium({
      direction: 'short',
      spot: SPOT,
      indexEntry: SPOT,
      indexStop: SPOT + 100,
      indexTarget: SPOT - 300,
      indexFirstReward: SPOT - 100,
      quote: put,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.optionType).toBe('PE');
    expect(out.plan.targetPremium).toBeGreaterThan(out.plan.entryPremium);
    expect(out.plan.premiumRR).toBeGreaterThanOrEqual(3);
  });
});
