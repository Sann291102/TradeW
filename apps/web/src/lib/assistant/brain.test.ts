import { describe, expect, it } from 'vitest';
import { validateAction, validateBrainPlan } from './brain';

/**
 * The client half of the two-sided validator (AI-OPERATING-SYSTEM.md §3,
 * services/tradew-ai/src/assistant/plan-schema.ts is the other half).
 *
 * These are security tests, not behaviour tests. The property being pinned is:
 * an LLM — prompted, jailbroken, compromised upstream, or simply wrong — cannot
 * cause `executeAction` to run anything outside the closed vocabulary. Every
 * case below is written as "what would an attacker or a confused model emit".
 */

describe('validateAction — the order boundary', () => {
  it.each([
    { type: 'placeOrder', symbol: 'NIFTY', qty: 50 },
    { type: 'modifyOrder', orderId: 'x' },
    { type: 'cancelOrder', orderId: 'x' },
    { type: 'submitOrder', side: 'BUY' },
    { type: 'trade', symbol: 'NIFTY' },
  ])('drops order-shaped action %j', (a) => {
    expect(validateAction(a)).toBeNull();
  });

  it('drops an order action even when wrapped in a valid-looking plan', () => {
    const plan = validateBrainPlan({
      goal: 'Buy the dip',
      steps: [
        { describe: 'Open the chart', action: { type: 'navigate', href: '/trade' } },
        { describe: 'Buy 50 lots', action: { type: 'placeOrder', symbol: 'NIFTY', qty: 50 } },
      ],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.action.type).toBe('navigate');
    expect(plan.dropped).toBe(1);
  });
});

describe('validateAction — navigation cannot escape the app', () => {
  it.each([
    'https://evil.example/steal',
    '//evil.example',
    '/settings/../admin',
    '/admin',
    '/api/auth/me',
    'javascript:alert(1)',
    '/../../etc/passwd',
  ])('drops href %j', (href) => {
    expect(validateAction({ type: 'navigate', href })).toBeNull();
  });

  it('allows a known route, with a query string', () => {
    expect(validateAction({ type: 'navigate', href: '/trade?view=optionChain' })).toEqual({
      type: 'navigate',
      href: '/trade?view=optionChain',
    });
  });

  it('allows a known route with a trailing slash', () => {
    expect(validateAction({ type: 'navigate', href: '/research/' })).not.toBeNull();
  });
});

describe('validateAction — payloads are checked, not just discriminants', () => {
  it('drops a theme outside the real ThemeName union', () => {
    expect(validateAction({ type: 'setTheme', theme: 'contrast' })).toBeNull();
    expect(validateAction({ type: 'setTheme', theme: 'neon' })).toBeNull();
    expect(validateAction({ type: 'setTheme', theme: 'high-contrast' })).toEqual({
      type: 'setTheme',
      theme: 'high-contrast',
    });
  });

  it('drops an unknown overlay', () => {
    expect(validateAction({ type: 'openOverlay', overlay: 'adminPanel' })).toBeNull();
  });

  it('drops a symbol that is not ticker-shaped', () => {
    expect(validateAction({ type: 'selectSymbol', symbol: '<script>' })).toBeNull();
    expect(validateAction({ type: 'selectSymbol', symbol: 'A'.repeat(50) })).toBeNull();
  });

  it('drops a quote with no usable symbols', () => {
    expect(validateAction({ type: 'quote', symbols: [] })).toBeNull();
    expect(validateAction({ type: 'quote', symbols: ['<img src=x>'] })).toBeNull();
  });

  it('caps quote symbols so one reply cannot fan out', () => {
    const a = validateAction({
      type: 'quote',
      symbols: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      ask: 'price',
    }) as { symbols: string[] } | null;
    expect(a?.symbols).toHaveLength(5);
  });
});

describe('validateAction — malformed input never throws', () => {
  it.each([null, undefined, 42, 'navigate', [], {}, { type: null }, { type: 123 }])(
    'returns null for %j',
    (input) => {
      expect(() => validateAction(input)).not.toThrow();
      expect(validateAction(input)).toBeNull();
    },
  );
});

describe('validateBrainPlan', () => {
  it('survives a completely malformed response', () => {
    expect(() => validateBrainPlan(null)).not.toThrow();
    expect(validateBrainPlan(null).steps).toEqual([]);
    expect(validateBrainPlan({ steps: 'not-an-array' }).steps).toEqual([]);
  });

  it('carries the server-reported drop count through, adding its own', () => {
    const plan = validateBrainPlan({
      dropped: 2,
      steps: [{ describe: 'x', action: { type: 'placeOrder' } }],
    });
    // 2 dropped server-side + 1 dropped here. The count is never reset.
    expect(plan.dropped).toBe(3);
  });

  it('keeps an unsupported explanation so the user is never left in silence', () => {
    const plan = validateBrainPlan({ steps: [], unsupported: 'I cannot place orders.' });
    expect(plan.unsupported).toBe('I cannot place orders.');
  });

  it('substitutes a describe rather than dropping an otherwise valid step', () => {
    const plan = validateBrainPlan({
      steps: [{ action: { type: 'toggleSidebar' } }],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.describe).toBeTruthy();
  });
});

describe('validateAction — panels must actually exist', () => {
  it('drops a panel name that is not a PanelKind', () => {
    // Observed from the live model: asked to review discipline it emitted
    // showPanel:'discipline', which is not a panel. It validated, executed as a
    // no-op, and the trace reported "✓ Open the Discipline panel" while nothing
    // changed on screen. A silent success is worse than a rejection.
    expect(validateAction({ type: 'showPanel', panel: 'discipline' })).toBeNull();
    expect(validateAction({ type: 'hidePanel', panel: 'discipline_review' })).toBeNull();
  });

  it('allows a real panel', () => {
    expect(validateAction({ type: 'showPanel', panel: 'optionChain' })).toEqual({
      type: 'showPanel',
      panel: 'optionChain',
    });
  });
});
