import { describe, expect, it, vi } from 'vitest';
import { SentinelEventDispatcher } from './sentinel-event-dispatcher.service';

/**
 * The dispatcher is the seam where an event stops being Sentinel's and becomes
 * a row a user reads without any of Sentinel's context around it. Three
 * properties are asserted here because each one, if it broke, would break
 * quietly:
 *
 *  1. a directional field cannot reach the database even if the sentinel
 *     service sends one (the boundary, not just the sender, holds the rule),
 *  2. a repeated poll writes nothing the second time, and
 *  3. a database fault costs the notification, never the observation.
 */

type Row = { userId: string; category: string; title: string; body: string; metadata: Record<string, unknown> };

/** Minimal Prisma double: records createMany input, replays findMany rows. */
function prismaDouble(existing: { metadata: unknown }[] = []) {
  const created: Row[] = [];
  return {
    created,
    notification: {
      findMany: vi.fn().mockResolvedValue(existing),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        created.push(...data);
        return { count: data.length };
      }),
    },
  };
}

const event = (over: Record<string, unknown> = {}) => ({
  kind: 'guidance-published',
  severity: 'info',
  title: 'NIFTY — SETUP FORMING',
  body: 'Price is holding above the opening range with volume confirming.',
  symbol: 'NIFTY',
  dedupeKey: 'guidance:SIDE_IN_FOCUS:SETUP FORMING',
  at: '2026-08-12T04:30:00.000Z',
  confidence: 88,
  state: 'SIDE_IN_FOCUS',
  ...over,
});

const make = (prisma: ReturnType<typeof prismaDouble>) =>
  new SentinelEventDispatcher(prisma as unknown as ConstructorParameters<typeof SentinelEventDispatcher>[0]);

describe('SentinelEventDispatcher — the boundary holds', () => {
  it('drops a directional field even when the sentinel service sends one', async () => {
    // The sender is supposed to make this impossible. This asserts the
    // RECEIVER does too: a partially-deployed or future sentinel build that
    // starts attaching a side must not be able to put it on a notification.
    const prisma = prismaDouble();
    await make(prisma).dispatch('user-1', {
      events: [event({ side: 'CE', bias: 'bullish', strike: 24500, optionContext: { pcr: 1.2 } })],
    });

    expect(prisma.created).toHaveLength(1);
    const serialised = JSON.stringify(prisma.created[0]);
    for (const banned of ['side', 'bias', 'strike', 'optionContext', 'CE']) {
      expect(serialised, `"${banned}" must not survive into the row`).not.toContain(banned);
    }
  });

  it('reads only `events` and ignores the rest of the observe response', async () => {
    const prisma = prismaDouble();
    await make(prisma).dispatch('user-1', {
      sideInFocus: { side: 'CE', strike: 24500 },
      synthesis: { content: 'Bullish continuation.' },
      publication: { publish: true },
      // no `events` key at all
    });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('SentinelEventDispatcher — dedupe', () => {
  it('writes nothing when the key was already notified today', async () => {
    const prisma = prismaDouble([{ metadata: { dedupeKey: 'guidance:SIDE_IN_FOCUS:SETUP FORMING' } }]);
    const written = await make(prisma).dispatch('user-1', { events: [event()] });

    expect(written).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('collapses a repeated key inside one observation', async () => {
    // The DB check was read before either row was written, so a batch
    // containing the same key twice would otherwise slip through it.
    const prisma = prismaDouble();
    const written = await make(prisma).dispatch('user-1', { events: [event(), event()] });

    expect(written).toBe(1);
    expect(prisma.created).toHaveLength(1);
  });

  it('lets a genuinely different key through', async () => {
    const prisma = prismaDouble([{ metadata: { dedupeKey: 'guidance:SIDE_IN_FOCUS:SETUP FORMING' } }]);
    const written = await make(prisma).dispatch('user-1', {
      events: [event(), event({ kind: 'safety-warning', severity: 'critical', dedupeKey: 'safety:high' })],
    });

    expect(written).toBe(1);
    expect(prisma.created[0].metadata.dedupeKey).toBe('safety:high');
  });

  it('caps runaway batches', async () => {
    const prisma = prismaDouble();
    const many = Array.from({ length: 12 }, (_, i) => event({ dedupeKey: `guidance:k${i}` }));
    const written = await make(prisma).dispatch('user-1', { events: many });

    expect(written).toBe(5);
  });
});

describe('SentinelEventDispatcher — never costs the observation', () => {
  it('resolves rather than rejecting when the database write fails', async () => {
    const prisma = prismaDouble();
    prisma.notification.createMany.mockRejectedValue(new Error('connection pool exhausted'));

    await expect(make(prisma).dispatch('user-1', { events: [event()] })).resolves.toBe(0);
  });

  it('resolves when the dedupe read fails', async () => {
    const prisma = prismaDouble();
    prisma.notification.findMany.mockRejectedValue(new Error('db down'));

    await expect(make(prisma).dispatch('user-1', { events: [event()] })).resolves.toBe(0);
  });

  it('ignores malformed payloads instead of throwing', async () => {
    const prisma = prismaDouble();
    const d = make(prisma);

    await expect(d.dispatch('user-1', null)).resolves.toBe(0);
    await expect(d.dispatch('user-1', { events: 'not-an-array' })).resolves.toBe(0);
    await expect(d.dispatch('user-1', { events: [{ kind: 'x' }] })).resolves.toBe(0);
    await expect(d.dispatch('user-1', { events: [event({ severity: 'shouty' })] })).resolves.toBe(0);
    await expect(d.dispatch('user-1', { events: [event({ title: '' })] })).resolves.toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('SentinelEventDispatcher — the row', () => {
  it('records severity, symbol and trading date in metadata under an existing category', async () => {
    const prisma = prismaDouble();
    await make(prisma).dispatch('user-1', {
      events: [event({ kind: 'emotional-risk', severity: 'critical', dedupeKey: 'emotion:70' })],
    });

    const row = prisma.created[0];
    expect(row.category).toBe('sentinel');
    expect(row.userId).toBe('user-1');
    expect(row.metadata.kind).toBe('sentinel_emotional_risk');
    expect(row.metadata.severity).toBe('critical');
    expect(row.metadata.symbol).toBe('NIFTY');
    expect(row.metadata.tradingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
