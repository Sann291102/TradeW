import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningApiService } from './learning.service';
import type { EntitlementsService, EntitlementDecision } from '../entitlements/entitlements.service';

/**
 * Entitlement + admin resolution for the Learning Platform.
 *
 * Pure, dependency-injected (a stub EntitlementsService) — no DB, no network,
 * matching services/api's existing guard-suite style. This is the security
 * boundary: which courses a user may open, and who counts as an administrator.
 */

function stubEntitlements(granted: Record<string, boolean>): EntitlementsService {
  return {
    async check(userId: string, capability: string): Promise<EntitlementDecision> {
      return {
        userId,
        capability,
        allowed: granted[capability] ?? false,
        reason: granted[capability] ? 'plan_grant' : 'no_subscription',
        decidedAt: new Date('2026-07-30T00:00:00Z'),
      };
    },
  } as unknown as EntitlementsService;
}

const FREE_COURSE = { id: 'trading-basics', free: true };
const PREMIUM_COURSE = { id: 'price-action', free: false };

describe('LearningApiService — access control', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });
  beforeEach(() => {
    delete process.env.LEARNING_ADMIN_EMAILS;
    delete process.env.LEARNING_PRO_CAPABILITY;
  });

  it('free course is open to everyone (no pro, not admin)', async () => {
    const svc = new LearningApiService(stubEntitlements({}));
    const access = await svc.access('u1', 'nobody@example.com', FREE_COURSE);
    expect(access).toEqual({ allowed: true, reason: 'free' });
  });

  it('premium course is locked for a free user', async () => {
    const svc = new LearningApiService(stubEntitlements({}));
    const access = await svc.access('u1', 'nobody@example.com', PREMIUM_COURSE);
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe('requires_pro');
  });

  it('premium course unlocks with the Pro (sentinel) capability', async () => {
    const svc = new LearningApiService(stubEntitlements({ sentinel: true }));
    const access = await svc.access('u1', 'nobody@example.com', PREMIUM_COURSE);
    expect(access).toEqual({ allowed: true, reason: 'pro' });
  });

  it('the Pro capability is configurable via LEARNING_PRO_CAPABILITY', async () => {
    process.env.LEARNING_PRO_CAPABILITY = 'learning';
    const svc = new LearningApiService(stubEntitlements({ learning: true, sentinel: false }));
    expect((await svc.access('u1', 'x@x.com', PREMIUM_COURSE)).reason).toBe('pro');
  });

  it('admin (email allowlist) unlocks everything, no subscription needed', async () => {
    process.env.LEARNING_ADMIN_EMAILS = 'boss@tradew.com, admin@tradew-setup.com';
    const svc = new LearningApiService(stubEntitlements({}));
    expect((await svc.access('u1', 'admin@tradew-setup.com', PREMIUM_COURSE)).reason).toBe('admin');
    // case-insensitive
    expect((await svc.access('u1', 'ADMIN@TRADEW-SETUP.COM', PREMIUM_COURSE)).reason).toBe('admin');
  });

  it('admin via the learning_admin entitlement override', async () => {
    const svc = new LearningApiService(stubEntitlements({ learning_admin: true }));
    expect(await svc.isAdmin('u1', 'nobody@example.com')).toBe(true);
    expect((await svc.access('u1', 'nobody@example.com', PREMIUM_COURSE)).reason).toBe('admin');
  });

  it('non-admin, non-pro user is not an admin', async () => {
    const svc = new LearningApiService(stubEntitlements({ sentinel: true }));
    expect(await svc.isAdmin('u1', 'nobody@example.com')).toBe(false);
  });

  it('locked payload advertises the premium unlocks and an upgrade link', () => {
    const svc = new LearningApiService(stubEntitlements({}));
    const payload = svc.lockedPayload();
    expect(payload.locked).toBe(true);
    expect(payload.title).toBe('Requires Sentinel Pro');
    expect(payload.unlocks).toContain('AI Teacher');
    expect(payload.unlocks).toContain('Quizzes');
    expect(payload.upgradeHref).toBe('/settings');
  });
});
