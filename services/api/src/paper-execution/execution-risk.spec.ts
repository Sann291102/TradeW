import { describe, expect, it } from 'vitest';
import {
  MAX_STOP_FRACTION,
  MIN_STOP_FRACTION,
  computeTrail,
  effectiveStop,
  planRisk,
  type RiskPlanInput,
} from './execution-risk';

/**
 * The three percentages, and the one invariant that must never break.
 *
 * `riskAtStop ≤ riskBudget` is the whole safety claim of this module. It is
 * asserted here over a swept space of inputs rather than on a handful of
 * chosen ones, because the failure mode is arithmetic and arithmetic failures
 * hide in the cases nobody thought to pick.
 */

const BASE: RiskPlanInput = {
  walletEquity: 1_000_000,
  entryPrice: 120,
  lotSize: 75,
  maxLots: 1,
  capitalAllocationPct: 20,
  riskPerTradePct: 3,
  rewardPerTradePct: 9,
};

describe('planRisk — the three bases', () => {
  it('computes each percentage against the base it names', () => {
    const plan = planRisk(BASE);
    expect(plan.ok).toBe(true);
    // 20% of EQUITY, not of anything else.
    expect(plan.allocationCeiling).toBe(200_000);
    // 3% and 9% of EQUITY — the reading knowledge-base/risk-management/
    // position-sizing.yaml states ("a predetermined fraction of capital").
    expect(plan.riskBudget).toBe(30_000);
    expect(plan.rewardTarget).toBe(90_000);
  });

  it('separates the allocation CEILING from the capital actually deployed', () => {
    const plan = planRisk(BASE);
    // 1 lot × 75 × ₹120 = ₹9,000 deployed against a ₹200,000 ceiling. Reporting
    // the ceiling as the deployment would overstate exposure 22-fold.
    expect(plan.allocatedCapital).toBe(9_000);
    expect(plan.allocatedCapital).toBeLessThan(plan.allocationCeiling);
  });

  it('never deploys more premium than the allocation ceiling', () => {
    // 100 lots requested; the ceiling only affords 22.
    const plan = planRisk({ ...BASE, maxLots: 100 });
    expect(plan.ok).toBe(true);
    expect(plan.allocatedCapital).toBeLessThanOrEqual(plan.allocationCeiling);
    expect(plan.bindingConstraint).toBe('allocation-ceiling');
    expect(plan.lots).toBe(22); // floor(200000 / (120 × 75))
  });
});

describe('planRisk — the stop', () => {
  it('places a stop that is a real stop, not "wait for zero"', () => {
    const plan = planRisk(BASE);
    // The budget over 75 units would allow a 400-point stop on a 120-point
    // option — i.e. below zero. It is capped at 35% of premium instead.
    expect(plan.stopDistance).toBe(120 * MAX_STOP_FRACTION);
    expect(plan.stopPrice).toBe(78);
    expect(plan.stopPrice).toBeGreaterThan(0);
  });

  it('spends the budget exactly when the size is large enough to need it', () => {
    const plan = planRisk({ ...BASE, maxLots: 20 });
    expect(plan.quantity).toBe(1_500);
    // 30,000 / 1,500 = 20 points, inside the 42-point cap, so the budget binds.
    expect(plan.stopDistance).toBe(20);
    expect(plan.riskAtStop).toBe(30_000);
    expect(plan.riskAtStop).toBe(plan.riskBudget);
  });

  it('never places a stop tighter than the noise floor', () => {
    // A huge account would otherwise buy enough size that the budget-derived
    // stop distance collapses to fractions of a point.
    const plan = planRisk({ ...BASE, walletEquity: 500_000_000, maxLots: 100_000 });
    expect(plan.ok).toBe(true);
    expect(plan.stopDistance).toBeGreaterThanOrEqual(BASE.entryPrice * MIN_STOP_FRACTION - 0.01);
  });

  it('keeps the stop price above zero even on a near-worthless premium', () => {
    const plan = planRisk({ ...BASE, entryPrice: 5.5 });
    expect(plan.ok).toBe(true);
    expect(plan.stopPrice).toBeGreaterThan(0);
  });
});

describe('planRisk — the target', () => {
  it('is the configured R multiple of the ACTUAL stop distance', () => {
    const plan = planRisk(BASE);
    // 9% against 3% is 3R, and it stays 3R even though the stop was capped —
    // deriving the target from the reward BUDGET instead would produce an
    // unreachable target whenever the stop had been reduced.
    expect(plan.rMultiple).toBe(3);
    expect(plan.targetDistance).toBe(plan.stopDistance * 3);
    expect(plan.targetPrice).toBe(plan.entryPrice + plan.targetDistance);
  });

  it('honours a non-3R configuration', () => {
    const plan = planRisk({ ...BASE, riskPerTradePct: 2, rewardPerTradePct: 5 });
    expect(plan.rMultiple).toBe(2.5);
    expect(plan.targetDistance).toBeCloseTo(plan.stopDistance * 2.5, 2);
  });
});

describe('planRisk — refusals', () => {
  it('refuses when one lot does not fit inside the allocation ceiling', () => {
    // 1% of a ₹100,000 account is ₹1,000; one lot costs ₹9,000.
    const plan = planRisk({ ...BASE, walletEquity: 100_000, capitalAllocationPct: 1 });
    expect(plan.ok).toBe(false);
    expect(plan.failedCheckId).toBe('allocation-ceiling');
    expect(plan.quantity).toBe(0);
  });

  it('refuses when one lot does not fit inside the risk budget', () => {
    // A risk budget too small to cover even the floor stop on one lot.
    const plan = planRisk({ ...BASE, riskPerTradePct: 0.005 });
    expect(plan.ok).toBe(false);
    expect(plan.failedCheckId).toBe('risk-budget');
  });

  it.each([
    ['zero equity', { walletEquity: 0 }, 'risk-equity'],
    ['a zero premium', { entryPrice: 0 }, 'risk-entry-price'],
    ['a nonsense lot size', { lotSize: 0 }, 'risk-lot-size'],
    ['zero lots', { maxLots: 0 }, 'risk-max-lots'],
    ['a zero risk percentage', { riskPerTradePct: 0 }, 'risk-percent'],
  ])('refuses %s', (_label, override, expectedCheck) => {
    const plan = planRisk({ ...BASE, ...(override as Partial<RiskPlanInput>) });
    expect(plan.ok).toBe(false);
    expect(plan.failedCheckId).toBe(expectedCheck);
  });
});

describe('planRisk — the invariant, swept', () => {
  it('NEVER risks more than the budget, across the whole input space', () => {
    let planned = 0;
    for (const walletEquity of [50_000, 250_000, 1_000_000, 7_500_000, 90_000_000]) {
      for (const entryPrice of [5.5, 18, 47.25, 120, 640, 990]) {
        for (const lotSize of [15, 20, 25, 50, 75]) {
          for (const maxLots of [1, 3, 17, 400]) {
            for (const [riskPct, rewardPct] of [
              [3, 9],
              [1, 2],
              [5, 15],
              [0.5, 4],
            ]) {
              const plan = planRisk({
                walletEquity,
                entryPrice,
                lotSize,
                maxLots,
                capitalAllocationPct: 20,
                riskPerTradePct: riskPct,
                rewardPerTradePct: rewardPct,
              });
              if (!plan.ok) continue;
              planned++;

              // THE invariant.
              expect(plan.riskAtStop).toBeLessThanOrEqual(plan.riskBudget + 0.01);
              // Exposure never exceeds its own ceiling.
              expect(plan.allocatedCapital).toBeLessThanOrEqual(plan.allocationCeiling + 0.01);
              // Always whole lots.
              expect(plan.quantity % lotSize).toBe(0);
              expect(plan.lots).toBeGreaterThanOrEqual(1);
              expect(plan.lots).toBeLessThanOrEqual(maxLots);
              // A stop is always below entry and above zero; a target above it.
              expect(plan.stopPrice).toBeGreaterThan(0);
              expect(plan.stopPrice).toBeLessThan(plan.entryPrice);
              expect(plan.targetPrice).toBeGreaterThan(plan.entryPrice);
              // The stop is inside both fractions of premium.
              expect(plan.stopDistance).toBeLessThanOrEqual(entryPrice * MAX_STOP_FRACTION + 0.01);
              expect(plan.stopDistance).toBeGreaterThanOrEqual(entryPrice * MIN_STOP_FRACTION - 0.01);
              // R is exactly the configured ratio.
              expect(plan.rMultiple).toBeCloseTo(rewardPct / riskPct, 6);
            }
          }
        }
      }
    }
    // Guards the sweep itself: a bug that made every plan fail would otherwise
    // pass every assertion above by never reaching one.
    expect(planned).toBeGreaterThan(500);
  });
});

describe('computeTrail', () => {
  const entryPrice = 120;
  const stepPoints = 3;

  it('does not activate before one whole step of profit', () => {
    expect(computeTrail({ entryPrice, highWaterPrice: 120, stepPoints })).toEqual({ steps: 0, trailPrice: null });
    expect(computeTrail({ entryPrice, highWaterPrice: 122.9, stepPoints })).toEqual({ steps: 0, trailPrice: null });
  });

  it('moves to breakeven on the first step, then one step at a time', () => {
    expect(computeTrail({ entryPrice, highWaterPrice: 123, stepPoints })).toEqual({ steps: 1, trailPrice: 120 });
    expect(computeTrail({ entryPrice, highWaterPrice: 126, stepPoints })).toEqual({ steps: 2, trailPrice: 123 });
    expect(computeTrail({ entryPrice, highWaterPrice: 129, stepPoints })).toEqual({ steps: 3, trailPrice: 126 });
    expect(computeTrail({ entryPrice, highWaterPrice: 150, stepPoints })).toEqual({ steps: 10, trailPrice: 147 });
  });

  it('advances several steps at once through a gap', () => {
    // A single fast move must not need ten ticks to book ten steps.
    const trail = computeTrail({ entryPrice, highWaterPrice: 155.5, stepPoints });
    expect(trail.steps).toBe(11);
    expect(trail.trailPrice).toBe(150);
  });

  it('is a function of the HIGH WATER mark, so it can never loosen', () => {
    // The high water is monotonic by construction, so this is really an
    // assertion that nothing here reads the current price.
    const high = computeTrail({ entryPrice, highWaterPrice: 140, stepPoints });
    const stillHigh = computeTrail({ entryPrice, highWaterPrice: 140, stepPoints });
    expect(stillHigh).toEqual(high);
    // Monotone in the high water mark.
    let previous = -Infinity;
    for (let hw = 120; hw <= 200; hw += 0.5) {
      const t = computeTrail({ entryPrice, highWaterPrice: hw, stepPoints });
      const level = t.trailPrice ?? -Infinity;
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it('degrades safely on nonsense inputs rather than producing a level', () => {
    expect(computeTrail({ entryPrice: 0, highWaterPrice: 50, stepPoints })).toEqual({ steps: 0, trailPrice: null });
    expect(computeTrail({ entryPrice, highWaterPrice: 200, stepPoints: 0 })).toEqual({ steps: 0, trailPrice: null });
  });
});

describe('effectiveStop', () => {
  it('is the initial stop until a trail exists', () => {
    expect(effectiveStop(78, null)).toBe(78);
  });

  it('is the trail once it is above the initial stop', () => {
    expect(effectiveStop(78, 120)).toBe(120);
  });

  it('never returns a level below the initial stop', () => {
    // Defensive: a trail below the stop would be a loosening, and the maximum
    // is what makes that unrepresentable rather than merely unlikely.
    expect(effectiveStop(78, 60)).toBe(78);
  });
});
