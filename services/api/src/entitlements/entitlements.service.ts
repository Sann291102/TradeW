import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { findCoupon } from './coupon.catalog';

/**
 * Centralized Subscription & Entitlement service — the ONLY place premium
 * access is decided. No hardcoded plan checks anywhere else in the codebase.
 *
 * Separation of concerns (locked decision Q7):
 *   auth = who you are; subscription = what plan you're on; billing = how you
 *   pay (future adapter, integrates only through the lifecycle methods below);
 *   entitlements = what features you get; usage = how much you may use.
 */

export interface EntitlementDecision {
  userId: string;
  capability: string;
  allowed: boolean;
  reason:
    | 'plan_grant'
    | 'trial'
    | 'grace_period'
    | 'override'
    | 'no_subscription'
    | 'plan_lacks_capability'
    | 'subscription_expired'
    | 'quota_exhausted'
    | 'override_revoked';
  quota?: { metric: string; limit: number; used: number; period: string };
  decidedAt: Date;
}

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.GRACE,
];

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- checks

  async check(userId: string, capability: string): Promise<EntitlementDecision> {
    const now = new Date();
    const base = { userId, capability, decidedAt: now };

    // NOTE (2026-08-10): a short-circuit here previously returned
    // `{ allowed: true, reason: 'trial' }` for `capability === 'sentinel'`,
    // "for testing" — but Sentinel is the flagship PREMIUM capability, so that
    // one line made the entire entitlement gate a no-op for it: every account,
    // paid or not, got Sentinel free, and it silently overrode admin
    // revocations. It also contradicted this service's own test suite. Removed
    // so Sentinel is decided by the same override → subscription → quota path as
    // every other capability. Grant it the normal way (a subscription to a plan
    // that includes it, or an EntitlementOverride) — the demo account is seeded
    // with a Sentinel Pro subscription and does exactly that.

    // 1. admin overrides win, newest first
    const override = await this.prisma.entitlementOverride.findFirst({
      where: { userId, capability, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: 'desc' },
    });
    if (override) {
      return override.granted
        ? { ...base, allowed: true, reason: 'override' }
        : { ...base, allowed: false, reason: 'override_revoked' };
    }

    // 2. live subscriptions, newest first
    const subs = await this.prisma.subscription.findMany({
      where: { userId, status: { in: LIVE_STATUSES } },
      include: { plan: { include: { grants: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (subs.length === 0) return { ...base, allowed: false, reason: 'no_subscription' };

    let sawValidSub = false;
    let sawExpired = false;
    for (const sub of subs) {
      const validity = this.validity(sub.status, sub.expiresAt, sub.trialEndsAt, sub.plan.graceDays, now);
      if (validity === 'expired') {
        sawExpired = true;
        continue;
      }
      sawValidSub = true;
      const grant = sub.plan.grants.find((g) => g.capability === capability);
      if (!grant) continue;

      // 3. quota, when the grant defines one
      if (grant.quotaMetric && grant.quotaLimit != null) {
        const periodKey = grant.quotaPeriod === 'DAY' ? dayKey(now) : monthKey(now);
        const counter = await this.prisma.usageCounter.findUnique({
          where: { userId_metric_periodKey: { userId, metric: grant.quotaMetric, periodKey } },
        });
        const used = counter?.used ?? 0;
        const quota = {
          metric: grant.quotaMetric,
          limit: grant.quotaLimit,
          used,
          period: grant.quotaPeriod ?? 'MONTH',
        };
        if (used >= grant.quotaLimit) return { ...base, allowed: false, reason: 'quota_exhausted', quota };
        return { ...base, allowed: true, reason: this.grantReason(sub.status, validity), quota };
      }
      return { ...base, allowed: true, reason: this.grantReason(sub.status, validity) };
    }

    if (sawValidSub) return { ...base, allowed: false, reason: 'plan_lacks_capability' };
    return { ...base, allowed: false, reason: sawExpired ? 'subscription_expired' : 'no_subscription' };
  }

  async capabilitiesOf(userId: string): Promise<string[]> {
    const now = new Date();
    const result = new Set<string>();

    const subs = await this.prisma.subscription.findMany({
      where: { userId, status: { in: LIVE_STATUSES } },
      include: { plan: { include: { grants: true } } },
    });
    for (const sub of subs) {
      if (this.validity(sub.status, sub.expiresAt, sub.trialEndsAt, sub.plan.graceDays, now) === 'expired') continue;
      for (const g of sub.plan.grants) result.add(g.capability);
    }

    const overrides = await this.prisma.entitlementOverride.findMany({
      where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: 'asc' },
    });
    for (const o of overrides) (o.granted ? result.add(o.capability) : result.delete(o.capability));

    // Sentinel is NOT force-added here — see the note in check(). It appears in
    // this list only when a real subscription grant or a granting override
    // provides it, so capabilitiesOf() and check() agree on who has it.

    return [...result].sort();
  }

  // -------------------------------------------------------------- redemption

  /**
   * Redeem a code for the real plan it names.
   *
   * This is the server-side half of a fix for a code that only ever worked in
   * the browser (see coupon.catalog.ts). It deliberately goes through
   * `activate()` rather than writing a subscription row itself, so a redeemed
   * plan is indistinguishable from a purchased one from here on: the same
   * status, the same expiry handling, the same grace period, the same
   * `capabilitiesOf` path. Nothing downstream needs to know a coupon was
   * involved.
   *
   * Idempotent per user. Redeeming twice does not stack two subscriptions and
   * does not extend the first — it reports what is already there. Without this
   * the endpoint is a free renewal button, since the catalogue cannot yet
   * express a per-code redemption limit.
   */
  async redeem(userId: string, rawCode: string): Promise<{
    success: boolean;
    alreadyActive: boolean;
    message: string;
    capabilities: string[];
    expiresAt: Date | null;
  }> {
    const coupon = findCoupon(rawCode);
    if (!coupon) {
      throw new BadRequestException('That code is not valid. Check it and try again.');
    }

    const plan = await this.prisma.plan.findUnique({ where: { code: coupon.planCode } });
    if (!plan || !plan.active) {
      // The catalogue names a plan that is not in the database. That is a
      // deployment mistake, not something the user did, so it must not be
      // reported to them as an invalid code.
      throw new NotFoundException(`coupon ${coupon.code} names unknown or inactive plan ${coupon.planCode}`);
    }

    const now = new Date();
    const existing = await this.prisma.subscription.findFirst({
      where: { userId, planId: plan.id, status: { in: LIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (
      existing &&
      this.validity(existing.status, existing.expiresAt, existing.trialEndsAt, plan.graceDays, now) !== 'expired'
    ) {
      return {
        success: true,
        alreadyActive: true,
        message: `${coupon.label} is already active on your account.`,
        capabilities: await this.capabilitiesOf(userId),
        expiresAt: existing.expiresAt,
      };
    }

    const expiresAt = new Date(now);
    expiresAt.setMonth(expiresAt.getMonth() + coupon.months);

    await this.activate(userId, coupon.planCode, { expiresAt });

    return {
      success: true,
      alreadyActive: false,
      message: `${coupon.label} unlocked successfully.`,
      // Read back rather than assumed: what the user now holds is whatever the
      // plan actually grants, which is the same list every gate will consult.
      capabilities: await this.capabilitiesOf(userId),
      expiresAt,
    };
  }

  /** Increment usage for both day and month windows; check() reads whichever the grant uses. */
  async recordUsage(userId: string, metric: string, amount = 1): Promise<void> {
    const now = new Date();
    for (const periodKey of [dayKey(now), monthKey(now)]) {
      await this.prisma.usageCounter.upsert({
        where: { userId_metric_periodKey: { userId, metric, periodKey } },
        update: { used: { increment: amount } },
        create: { userId, metric, periodKey, used: amount },
      });
    }
  }

  // ------------------------------------------------- subscription lifecycle
  // Future billing adapters (Stripe/Razorpay/...) drive subscription state
  // exclusively through these methods.

  async activate(userId: string, planCode: string, opts: { trial?: boolean; expiresAt?: Date | null } = {}) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan || !plan.active) throw new NotFoundException(`unknown or inactive plan: ${planCode}`);
    const now = new Date();
    const trial = Boolean(opts.trial && plan.trialDays > 0);
    return this.prisma.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: trial ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE,
        trialEndsAt: trial ? new Date(now.getTime() + plan.trialDays * 86400_000) : null,
        expiresAt: opts.expiresAt ?? null,
        billingProvider: 'none',
      },
    });
  }

  async renew(subscriptionId: string, newExpiry: Date) {
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: SubscriptionStatus.ACTIVE, expiresAt: newExpiry, canceledAt: null },
    });
  }

  async markPastDue(subscriptionId: string) {
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: SubscriptionStatus.PAST_DUE },
    });
  }

  async cancel(subscriptionId: string, atPeriodEnd = true) {
    const now = new Date();
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: atPeriodEnd
        ? { canceledAt: now } // stays usable until expiresAt passes
        : { canceledAt: now, status: SubscriptionStatus.CANCELED },
    });
  }

  async expire(subscriptionId: string) {
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: SubscriptionStatus.EXPIRED },
    });
  }

  async createOverride(input: {
    userId: string;
    capability: string;
    granted: boolean;
    reason: string;
    grantedBy: string;
    expiresAt?: Date | null;
  }) {
    return this.prisma.entitlementOverride.create({ data: { ...input, expiresAt: input.expiresAt ?? null } });
  }

  async listPlans() {
    return this.prisma.plan.findMany({ where: { active: true }, include: { grants: true }, orderBy: { name: 'asc' } });
  }

  // ----------------------------------------------------------------- utils

  private validity(
    status: SubscriptionStatus,
    expiresAt: Date | null,
    trialEndsAt: Date | null,
    graceDays: number,
    now: Date,
  ): 'valid' | 'grace' | 'expired' {
    const graceMs = graceDays * 86400_000;
    const hardEnd = status === SubscriptionStatus.TRIALING ? trialEndsAt : expiresAt;
    if (!hardEnd) return 'valid'; // open-ended until canceled/expired by lifecycle
    if (now <= hardEnd) return 'valid';
    if (now.getTime() <= hardEnd.getTime() + graceMs) return 'grace';
    return 'expired';
  }

  private grantReason(status: SubscriptionStatus, validity: 'valid' | 'grace'): EntitlementDecision['reason'] {
    if (validity === 'grace') return 'grace_period';
    return status === SubscriptionStatus.TRIALING ? 'trial' : 'plan_grant';
  }
}
