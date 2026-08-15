import { describe, expect, it } from 'vitest';
import { alertRMultiple, alertTier, alertWatchId } from './alertTier';

/**
 * The payloads below mirror what `build_payload` / `build_intrade_payload` in
 * services/sentinel-py/app/notify/dispatcher.py actually send, narrowed to the
 * fields the ingress allowlists in sentinel-py.controller.ts.
 */
function sentinel(metadata: Record<string, unknown>) {
  return { category: 'sentinel', metadata };
}

describe('alertTier', () => {
  it('tones a forming setup as a warning, not a confirmation', () => {
    const tier = alertTier(sentinel({ tier: 'wait_and_watch', state: 'FORMING' }));
    expect(tier).toEqual({ key: 'wait_and_watch', label: 'Wait & Watch', tone: 'warning' });
  });

  it('tones a confirmed setup as brand — nothing has been gained yet', () => {
    const tier = alertTier(sentinel({ tier: 'side_in_focus', state: 'CONFIRMED' }));
    expect(tier?.key).toBe('side_in_focus');
    expect(tier?.tone).toBe('brand');
  });

  it('labels a milestone with the ratio its body quotes', () => {
    const tier = alertTier(sentinel({ tier: 'in_trade', event: 'milestone', milestone: '2R', rMultiple: 2.1 }));
    expect(tier?.label).toBe('2:1 reached');
    expect(tier?.tone).toBe('positive');
  });

  it('falls back to a generic progress label when no milestone was sent', () => {
    const tier = alertTier(sentinel({ tier: 'in_trade', event: 'milestone', rMultiple: 1.4 }));
    expect(tier?.key).toBe('milestone');
    expect(tier?.label).toBe('Progress');
  });

  it('separates the in-trade events from one another', () => {
    expect(alertTier(sentinel({ tier: 'in_trade', event: 'invalidation_reached' }))?.tone).toBe('negative');
    expect(alertTier(sentinel({ tier: 'in_trade', event: 'projected_level_reached' }))?.tone).toBe('positive');
    expect(alertTier(sentinel({ tier: 'in_trade', event: 'structure_break' }))?.tone).toBe('warning');
  });

  it('degrades to a plain in-trade badge for an event it does not know', () => {
    const tier = alertTier(sentinel({ tier: 'in_trade', event: 'something_new' }));
    expect(tier?.key).toBe('in_trade');
  });

  it('is null for anything that is not a tiered Sentinel alert', () => {
    expect(alertTier({ category: 'trade', metadata: { tier: 'side_in_focus' } })).toBeNull();
    // Sentinel notifications written before tiers existed.
    expect(alertTier({ category: 'sentinel' })).toBeNull();
    expect(alertTier(sentinel({ source: 'sentinel-py' }))).toBeNull();
    expect(alertTier({ category: 'sentinel', metadata: 'not an object' })).toBeNull();
    expect(alertTier({ category: 'sentinel', metadata: ['array'] })).toBeNull();
  });
});

describe('alertRMultiple', () => {
  it('reads a measured value', () => {
    expect(alertRMultiple(sentinel({ tier: 'in_trade', rMultiple: 2.05 }))).toBe(2.05);
    expect(alertRMultiple(sentinel({ tier: 'in_trade', rMultiple: -0.5 }))).toBe(-0.5);
  });

  it('never invents one', () => {
    expect(alertRMultiple(sentinel({ tier: 'in_trade', rMultiple: null }))).toBeNull();
    expect(alertRMultiple(sentinel({ tier: 'side_in_focus' }))).toBeNull();
    expect(alertRMultiple({ category: 'sentinel' })).toBeNull();
  });
});

describe('alertWatchId', () => {
  it('carries the watch the alert came from', () => {
    expect(alertWatchId(sentinel({ watchSessionId: 'w-1' }))).toBe('w-1');
    expect(alertWatchId(sentinel({ watchSessionId: null }))).toBeNull();
  });
});
