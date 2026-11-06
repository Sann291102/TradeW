import { describe, expect, it } from 'vitest';
import { attributeOrder } from './order-attribution';

const profile = { name: 'NIFTY alpha', agent: 'sentinel-alpha' };

describe('attributeOrder', () => {
  it('labels an order with no intent links as manual', () => {
    expect(attributeOrder({ executionIntentId: null, exitOfIntentId: null })).toEqual({
      source: 'MANUAL',
      agent: null,
      profileName: null,
      role: null,
      exitReason: null,
    });
  });

  it('labels an agent entry with the agent and profile that produced it', () => {
    const a = attributeOrder({ executionIntentId: 'i1', exitOfIntentId: null, entryIntent: { profile } });
    expect(a).toMatchObject({ source: 'AGENT', agent: 'sentinel-alpha', profileName: 'NIFTY alpha', role: 'ENTRY', exitReason: null });
  });

  it('labels an agent exit and carries the reason the agent recorded', () => {
    const a = attributeOrder({
      executionIntentId: null,
      exitOfIntentId: 'i1',
      exitIntent: { profile, outcome: { exitReason: 'SQUARE_OFF' } },
    });
    expect(a).toMatchObject({ source: 'AGENT', role: 'EXIT', exitReason: 'SQUARE_OFF' });
  });

  it('does not present PENDING as an exit reason', () => {
    const a = attributeOrder({
      executionIntentId: null,
      exitOfIntentId: 'i1',
      exitIntent: { profile, outcome: { exitReason: 'PENDING' } },
    });
    expect(a.exitReason).toBeNull();
  });

  it('still marks an agent order when the intent relation was not loaded', () => {
    const a = attributeOrder({ executionIntentId: 'i1', exitOfIntentId: null });
    expect(a).toMatchObject({ source: 'AGENT', agent: null, role: 'ENTRY' });
  });

  it('treats an order that closes an intent as an exit even if it also has an entry link', () => {
    const a = attributeOrder({ executionIntentId: 'i2', exitOfIntentId: 'i1' });
    expect(a.role).toBe('EXIT');
  });
});
