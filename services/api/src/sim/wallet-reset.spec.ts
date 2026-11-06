import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WalletResetService } from './wallet-reset.service';

function fakePrisma(agentPositions: number) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, count: number) =>
    vi.fn(async (arg: unknown) => {
      (calls[name] ??= []).push(arg);
      return { count };
    });
  const tx = {
    executionPosition: { count: vi.fn(async () => agentPositions) },
    order: { updateMany: record('order', 2) },
    position: { updateMany: record('position', 3) },
    holding: { updateMany: record('holding', 1) },
    paperWallet: {
      upsert: vi.fn(async (arg: unknown) => {
        (calls.wallet ??= []).push(arg);
        return {};
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, calls };
}

describe('WalletResetService', () => {
  it('restores ₹10,00,000 and clears everything the old balance depended on', async () => {
    const { prisma, calls } = fakePrisma(0);
    const result = await new WalletResetService(prisma as never).reset('u1');

    expect(result).toEqual({ balance: 1_000_000, cancelledOrders: 2, closedPositions: 3, clearedHoldings: 1 });
    expect(calls.wallet[0]).toMatchObject({
      where: { userId: 'u1' },
      update: { startingBalance: 1_000_000, cashBalance: 1_000_000, marginUsed: 0, realizedPnl: 0, resetAt: expect.any(Date) },
    });
    expect(calls.order[0]).toMatchObject({ data: { status: 'CANCELLED', marginBlocked: 0 } });
    expect(calls.position[0]).toMatchObject({ data: { quantity: 0, marginUsed: 0 } });
  });

  it('only ever touches the requesting user', async () => {
    const { prisma, calls } = fakePrisma(0);
    await new WalletResetService(prisma as never).reset('u1');
    for (const name of ['order', 'position', 'holding']) {
      expect((calls[name][0] as { where: { userId: string } }).where.userId).toBe('u1');
    }
  });

  it('refuses while an agent is holding a position, and changes nothing', async () => {
    const { prisma, calls } = fakePrisma(1);
    await expect(new WalletResetService(prisma as never).reset('u1')).rejects.toBeInstanceOf(ConflictException);
    expect(calls.wallet).toBeUndefined();
    expect(calls.order).toBeUndefined();
  });
});
