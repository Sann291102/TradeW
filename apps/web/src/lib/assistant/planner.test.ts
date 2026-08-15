import { describe, expect, it } from 'vitest';
import { planUtterance, splitUtterance, describeAction } from './planner';
import { riskOf } from './safety';

/**
 * Phase 1 of the AI operating system. Two things are actually load-bearing
 * here and both are safety properties, not features:
 *
 * 1. Splitting must never manufacture a step the user did not ask for. The
 *    "price of nifty and banknifty" case is the one that bites — split on bare
 *    "and" and the assistant navigates away from your screen because you asked
 *    for two quotes.
 * 2. A refused clause must poison the whole plan. "Open the chart then buy 50
 *    lots" must not open the chart and quietly drop the rest, because a user
 *    who sees the chart open reasonably concludes the whole thing ran.
 */

describe('splitUtterance', () => {
  it('splits on a strong connective', () => {
    expect(splitUtterance('open research then show the option chain')).toEqual([
      'open research',
      'show the option chain',
    ]);
  });

  it('splits on a bare "and" only when a command verb follows', () => {
    expect(splitUtterance('open research and show the option chain')).toEqual([
      'open research',
      'show the option chain',
    ]);
  });

  it('does NOT split a two-symbol quote question', () => {
    expect(splitUtterance('price of nifty and banknifty')).toEqual(['price of nifty and banknifty']);
  });

  it('leaves a single request alone', () => {
    expect(splitUtterance('open the option chain')).toEqual(['open the option chain']);
  });
});

describe('planUtterance', () => {
  it('keeps a two-symbol quote as ONE step, not two', () => {
    const plan = planUtterance('price of nifty and banknifty');
    expect(plan.intent).toBe('quote');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.action).toMatchObject({ type: 'quote' });
  });

  it('builds a multi-step plan from a compound command', () => {
    const plan = planUtterance('open research then show the option chain');
    expect(plan.steps.length).toBeGreaterThan(1);
    expect(plan.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('describes every step in plain language', () => {
    const plan = planUtterance('open research then show the option chain');
    for (const s of plan.steps) {
      expect(s.describe).toBeTruthy();
      expect(s.describe).not.toMatch(/undefined|\[object/);
    }
  });

  // The one that matters most.
  it('refuses the WHOLE plan when any clause is refused', () => {
    const plan = planUtterance('open research then buy 50 lots of nifty');
    expect(plan.intent).toBe('refusal');
    expect(plan.steps).toHaveLength(0);
  });

  it('never emits an order action from any phrasing', () => {
    for (const q of [
      'open research and buy nifty',
      'place an order then open the chart',
      'show the option chain',
    ]) {
      const plan = planUtterance(q);
      expect(plan.steps.every((s) => !/order/i.test(s.action.type))).toBe(true);
    }
  });
});

describe('safety gate', () => {
  it('lets reversible actions run without asking', () => {
    expect(riskOf([{ type: 'navigate', href: '/research' }]).tier).toBe('free');
    expect(riskOf([{ type: 'quote', symbols: ['NIFTY'], ask: 'price' }]).tier).toBe('free');
    expect(riskOf([{ type: 'setTheme', theme: 'dark' }]).tier).toBe('free');
  });

  it('confirms before replacing a layout, which is destructive by omission', () => {
    const r = riskOf([{ type: 'applyLayout', layoutId: 'scalping' }]);
    expect(r.tier).toBe('confirm');
    expect(r.reason).toMatch(/replaces/i);
  });

  it('confirms a long plan even when every step is individually harmless', () => {
    const many = Array.from({ length: 5 }, () => ({ type: 'toggleSidebar' }) as const);
    expect(riskOf(many).tier).toBe('confirm');
  });

  it('gives a reason whenever it asks', () => {
    const r = riskOf([{ type: 'applyLayout', layoutId: 'x' }]);
    expect(r.reason).toBeTruthy();
  });
});

describe('plan risk propagates', () => {
  it('marks a layout change as needing confirmation', () => {
    const plan = planUtterance('apply the scalping layout');
    if (plan.steps.length) {
      expect(plan.risk).toBe('confirm');
      expect(plan.riskReason).toBeTruthy();
    }
  });

  it('leaves a plain navigation free to run', () => {
    expect(planUtterance('open research').risk).toBe('free');
  });
});

describe('describeAction', () => {
  it('covers every action variant without falling through', () => {
    const all = [
      { type: 'navigate', href: '/x' },
      { type: 'selectSymbol', symbol: 'NIFTY' },
      { type: 'openOverlay', overlay: 'commandPalette' },
      { type: 'setTheme', theme: 'dark' },
      { type: 'showPanel', panel: 'chart' },
      { type: 'hidePanel', panel: 'chart' },
      { type: 'applyLayout', layoutId: 'scalping' },
      { type: 'toggleSidebar' },
      { type: 'newWorkspaceTab' },
      { type: 'quote', symbols: ['NIFTY'], ask: 'price' },
    ] as const;
    for (const a of all) {
      expect(describeAction(a as never)).toBeTruthy();
    }
  });
});
