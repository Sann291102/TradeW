import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@prisma/client';
import { EntitlementsService } from './entitlements.service';
import { ALL_COUPONS, findCoupon, normalizeCode } from './coupon.catalog';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Redemption, which used to happen entirely in the browser.
 *
 * `sessionStore.redeemCoupon` compared the code client-side, pushed 'sentinel'
 * into a localStorage array, and told the user their plan was active — while
 * `services/api`, never told anything, returned 403 to every premium call.
 * Reported as "purchased using redeem code but it failed to load the premium
 * feature".
 *
 * What is pinned here is the property that makes the new path real rather than
 * decorative: redeeming creates a SUBSCRIPTION, and the capabilities the caller
 * gets back are read from the same `capabilitiesOf` path every gate consults.
 * A test that asserted a returned message would have passed against the broken
 * client-side version too.
 *
 * Structural Prisma stub over plain arrays, matching entitlements.spec.ts — no
 * database, deterministic.
 */

const SENTINEL_PLAN = {
  id: 'plan-sentinel',
  code: 'sentinel_pro',
  active: true,
  trialDays: 0,
  graceDays: 3,
  grants: [{ capability: 'sentinel' }, { capability: 'paper_trading' }],
};

function makeService(opts: { plans?: unknown[]; subscriptions?: Record<string, unknown>[] } = {}) {
  const plans = opts.plans ?? [SENTINEL_PLAN];
  const subscriptions: Record<string, unknown>[] = [...(opts.subscriptions ?? [])];

  const prisma = {
    plan: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        plans.find((p) => (p as { code: string }).code === where.code) ?? null,
    },
    subscription: {
      findFirst: async ({ where }: { where: { userId: string; planId: string } }) =>
        subscriptions.find((s) => s.userId === where.userId && s.planId === where.planId) ?? null,
      findMany: async ({ where }: { where: { userId: string } }) =>
        subscriptions
          .filter((s) => s.userId === where.userId)
          .map((s) => ({ ...s, plan: plans.find((p) => (p as { id: string }).id === s.planId) })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `sub-${subscriptions.length + 1}`, createdAt: new Date() };
        subscriptions.push(row);
        return row;
      },
    },
    entitlementOverride: { findMany: async () => [], findFirst: async () => null },
    usageCounter: { findUnique: async () => null },
  } as unknown as PrismaService;

  return { service: new EntitlementsService(prisma), subscriptions };
}

describe('code normalisation', () => {
  it.each([
    'HashtagTradeWSetup100',
    '#HashtagTradeWSetup100',
    '  hashtagtradewsetup100  ',
    'HASHTAGTRADEWSETUP100',
  ])('accepts %j — people paste the hash, the spaces and any casing', (raw) => {
    expect(findCoupon(raw)?.planCode).toBe('sentinel_pro');
  });

  it('rejects an unknown code', () => {
    expect(findCoupon('NOPE123')).toBeNull();
    expect(findCoupon('')).toBeNull();
  });

  it('never stores a code that its own normaliser would alter', () => {
    // A catalogue entry with a capital or a stray space could never be matched.
    for (const c of ALL_COUPONS) expect(normalizeCode(c.code)).toBe(c.code);
  });
});

describe('redeem', () => {
  it('creates a real subscription, not a message', async () => {
    const { service, subscriptions } = makeService();
    await service.redeem('user-1', 'HashtagTradeWSetup100');

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ userId: 'user-1', planId: 'plan-sentinel' });
  });

  /**
   * The assertion that would have failed against the old client-side version:
   * the capability has to be visible through the same path the gate reads.
   */
  it('grants the capability through capabilitiesOf, which is what the gate checks', async () => {
    const { service } = makeService();
    expect(await service.capabilitiesOf('user-1')).not.toContain('sentinel');

    const res = await service.redeem('user-1', 'HashtagTradeWSetup100');

    expect(res.capabilities).toContain('sentinel');
    expect(await service.capabilitiesOf('user-1')).toContain('sentinel');
    expect((await service.check('user-1', 'sentinel')).allowed).toBe(true);
  });

  it('sets an expiry a month out rather than granting forever', async () => {
    const { service } = makeService();
    const res = await service.redeem('user-1', 'HashtagTradeWSetup100');

    expect(res.expiresAt).toBeInstanceOf(Date);
    const days = (res.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('rejects an unknown code without creating anything', async () => {
    const { service, subscriptions } = makeService();
    await expect(service.redeem('user-1', 'NOPE123')).rejects.toThrow(/not valid/i);
    expect(subscriptions).toHaveLength(0);
  });

  /**
   * The catalogue cannot express a per-code redemption limit yet, so without
   * this the endpoint is a free renewal button.
   */
  it('is idempotent — a second redemption does not stack a second subscription', async () => {
    const { service, subscriptions } = makeService();
    await service.redeem('user-1', 'HashtagTradeWSetup100');
    const again = await service.redeem('user-1', 'HashtagTradeWSetup100');

    expect(again.alreadyActive).toBe(true);
    expect(again.capabilities).toContain('sentinel');
    expect(subscriptions).toHaveLength(1);
  });

  it('lets a user whose plan expired redeem again', async () => {
    const expired = {
      userId: 'user-1',
      planId: 'plan-sentinel',
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(Date.now() - 90 * 86_400_000),
      trialEndsAt: null,
      createdAt: new Date(Date.now() - 120 * 86_400_000),
    };
    const { service, subscriptions } = makeService({ subscriptions: [expired] });

    const res = await service.redeem('user-1', 'HashtagTradeWSetup100');
    expect(res.alreadyActive).toBe(false);
    expect(subscriptions).toHaveLength(2);
    expect(res.capabilities).toContain('sentinel');
  });

  it('keeps one user\'s redemption off another user\'s account', async () => {
    const { service } = makeService();
    await service.redeem('user-1', 'HashtagTradeWSetup100');

    expect(await service.capabilitiesOf('user-2')).not.toContain('sentinel');
    expect((await service.check('user-2', 'sentinel')).allowed).toBe(false);
  });

  /**
   * A valid code naming a plan that is not in the database is a deployment
   * mistake. Reporting it as an invalid code sends the user to retype a
   * perfectly good one, and sends operators hunting for a typo.
   */
  it('does not blame the user when the catalogue names a missing plan', async () => {
    const { service } = makeService({ plans: [] });
    await expect(service.redeem('user-1', 'HashtagTradeWSetup100')).rejects.toThrow(/unknown or inactive plan/i);
  });
});
