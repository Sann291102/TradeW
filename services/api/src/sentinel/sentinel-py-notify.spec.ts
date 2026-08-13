import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { SentinelPyController } from './sentinel-py.controller';

/**
 * The ingress writes the row a user actually reads, and it deliberately
 * ALLOWLISTS the metadata fields that may reach the database rather than
 * spreading whatever sentinel-py sent.
 *
 * That allowlist is load-bearing in both directions, so both are asserted
 * here: the fields the notification bell styles from must survive the
 * crossing (without `tier`/`event` every Sentinel alert renders identically),
 * and anything not named must not — a field that slips through is a field
 * nobody reviewed against ARCH-4.
 */

const TOKEN = 'sentinel-py-test-token-0123456789';

type Row = { userId: string; category: string; title: string; body: string; metadata: Record<string, unknown> };

function prismaDouble(existing: { metadata: unknown }[] = []) {
  const created: Row[] = [];
  return {
    created,
    notification: {
      findMany: vi.fn().mockResolvedValue(existing),
      create: vi.fn(async ({ data }: { data: Row }) => {
        created.push(data);
        return { id: 'n1', ...data };
      }),
    },
  };
}

const make = (prisma: ReturnType<typeof prismaDouble>) =>
  new SentinelPyController(prisma as unknown as PrismaService);

/** A tier alert, as `build_payload` in app/notify/dispatcher.py sends it. */
const tierPayload = {
  userId: 'u1',
  category: 'sentinel',
  title: 'Side in Focus',
  body: 'Your strategy "15-Min ORB" on NIFTY 24300 CE has met all the conditions you defined.',
  metadata: {
    source: 'sentinel-py',
    watchSessionId: 'w1',
    strategyId: 's1',
    symbol: 'NIFTY',
    strike: '24300',
    optionType: 'CE',
    state: 'CONFIRMED',
    previousState: 'FORMING',
    tier: 'side_in_focus',
    reason: 'all 2 mandatory conditions met',
    dedupeKey: 'sentinel-py:w1:CONFIRMED',
    tradingDate: '2026-08-13',
  },
};

/** An in-trade alert, as `build_intrade_payload` sends it. */
const intradePayload = {
  userId: 'u1',
  category: 'sentinel',
  title: 'Position Progress',
  body: 'Your position from strategy "15-Min ORB" on NIFTY 24300 CE: your position has moved 2:1.',
  metadata: {
    source: 'sentinel-py',
    watchSessionId: 'w1',
    strategyId: 's1',
    symbol: 'NIFTY',
    strike: '24300',
    optionType: 'CE',
    state: 'IN_TRADE',
    tier: 'in_trade',
    event: 'milestone',
    rMultiple: 2.05,
    milestone: '2R',
    reason: 'your position has moved 2:1 relative to the risk you defined',
    dedupeKey: 'sentinel-py:w1:milestone:2R',
    tradingDate: '2026-08-13',
  },
};

describe('SentinelPyController — what reaches the notification row', () => {
  beforeEach(() => {
    process.env.SENTINEL_PY_SERVICE_TOKEN = TOKEN;
  });

  it('carries the tier the bell styles from', async () => {
    const prisma = prismaDouble();
    await make(prisma).notify(TOKEN, tierPayload);
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0].metadata.tier).toBe('side_in_focus');
    expect(prisma.created[0].metadata.state).toBe('CONFIRMED');
    expect(prisma.created[0].category).toBe('sentinel');
  });

  it('carries the in-trade event, milestone and R-multiple', async () => {
    const prisma = prismaDouble();
    await make(prisma).notify(TOKEN, intradePayload);
    const meta = prisma.created[0].metadata;
    // Without these three, every in-trade alert arrives as an undifferentiated
    // 'in_trade' tier and the drawer cannot tell progress from invalidation.
    expect(meta.event).toBe('milestone');
    expect(meta.milestone).toBe('2R');
    expect(meta.rMultiple).toBe(2.05);
  });

  it('still refuses to pass through a field nobody allowlisted', async () => {
    const prisma = prismaDouble();
    await make(prisma).notify(TOKEN, {
      ...tierPayload,
      metadata: { ...tierPayload.metadata, side: 'CE', recommendation: 'buy', entryPrice: 245.5 },
    });
    const meta = prisma.created[0].metadata;
    expect(meta).not.toHaveProperty('side');
    expect(meta).not.toHaveProperty('recommendation');
    expect(meta).not.toHaveProperty('entryPrice');
  });

  it('writes null rather than undefined for fields an alert does not carry', async () => {
    const prisma = prismaDouble();
    await make(prisma).notify(TOKEN, tierPayload);
    const meta = prisma.created[0].metadata;
    // A tier alert has no in-trade fields; JSON columns should hold an explicit
    // null, not a key that vanishes on serialization.
    expect(meta.event).toBeNull();
    expect(meta.rMultiple).toBeNull();
    expect(meta.milestone).toBeNull();
  });

  it('deduplicates on the key sentinel-py sent, per trading day', async () => {
    const prisma = prismaDouble([{ metadata: { dedupeKey: 'sentinel-py:w1:CONFIRMED' } }]);
    const result = await make(prisma).notify(TOKEN, tierPayload);
    expect(result).toEqual({ written: 0, deduped: true });
    expect(prisma.created).toHaveLength(0);
  });

  it('rejects a caller without the service token', async () => {
    const prisma = prismaDouble();
    await expect(make(prisma).notify('wrong-token', tierPayload)).rejects.toThrow();
    await expect(make(prisma).notify(undefined, tierPayload)).rejects.toThrow();
    expect(prisma.created).toHaveLength(0);
  });
});
