import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import type { AdminGuard } from './admin.guard';
import type { OperatorService } from './operator/operator.service';

/**
 * The two-door admin gate.
 *
 * The property under test is the one the user insisted on before any code
 * moved: adding the operator door must not change the product-admin door, and
 * the operator token must be REQUIRED on the operator door while never being
 * SUFFICIENT on its own. The cases below fix exactly that.
 *
 * Structural stubs, matching the guard suites in `broker/` and `auth/`: no Nest
 * context, no database, no JWT library. `AdminGuard` is a spy so we can prove it
 * is called verbatim (or not called at all) rather than re-implemented.
 */

const GOOD_TOKEN = 'operator-token-long-enough-to-be-accepted-xxxx';

function contextWith(headers: Record<string, string>): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; ip: string; url: string; user?: unknown };
} {
  const req = { headers, ip: '10.0.0.1', url: '/admin/whatever' };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

/** An AdminGuard test double that records whether it was consulted. */
function spyAdminGuard(result: boolean | Error): { guard: AdminGuard; calls: () => number } {
  let calls = 0;
  const guard = {
    canActivate: async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as AdminGuard;
  return { guard, calls: () => calls };
}

function stubOperators(verify: OperatorService['verifyAssertion']): OperatorService {
  return { verifyAssertion: verify, touch: () => undefined } as unknown as OperatorService;
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = GOOD_TOKEN;
});
afterEach(() => {
  delete process.env.ADMIN_API_TOKEN;
  vi.restoreAllMocks();
});

describe('AdminAccessGuard — no operator assertion → product-admin path, unchanged', () => {
  it('delegates the whole decision to AdminGuard when no assertion header is present', async () => {
    const admin = spyAdminGuard(true);
    const operators = stubOperators(async () => {
      throw new Error('operator path must not run for a product-admin request');
    });
    const guard = new AdminAccessGuard(admin.guard, operators);

    const { ctx } = contextWith({ authorization: 'Bearer jwt', 'x-admin-token': GOOD_TOKEN });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(admin.calls()).toBe(1);
  });

  it("propagates AdminGuard's denial verbatim — no fallback to the operator path", async () => {
    const admin = spyAdminGuard(new UnauthorizedException('Invalid admin token'));
    const operators = stubOperators(async () => {
      throw new Error('a failed product-admin request must never be retried as an operator');
    });
    const guard = new AdminAccessGuard(admin.guard, operators);

    const { ctx } = contextWith({ authorization: 'Bearer jwt' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(admin.calls()).toBe(1);
  });

  it('treats an empty assertion header as absent (product-admin path)', async () => {
    const admin = spyAdminGuard(true);
    const guard = new AdminAccessGuard(admin.guard, stubOperators(async () => ({ ok: false, reason: 'invalid_assertion' })));

    const { ctx } = contextWith({ 'x-operator-assertion': '' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(admin.calls()).toBe(1);
  });
});

describe('AdminAccessGuard — operator path requires the token, and it is never sufficient alone', () => {
  it('rejects a valid assertion when the operator token is missing', async () => {
    const admin = spyAdminGuard(true);
    const operators = stubOperators(async () => ({ ok: true, operator: { id: 'op-1', email: 'op@tradew.io', name: null } }));
    const guard = new AdminAccessGuard(admin.guard, operators);

    // Assertion present, token absent. The token is the FIRST check, so the
    // assertion is never even verified.
    const { ctx } = contextWith({ 'x-operator-assertion': 'signed' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(admin.calls()).toBe(0);
  });

  it('rejects a valid token with no valid assertion — the token alone opens nothing', async () => {
    const operators = stubOperators(async () => ({ ok: false, reason: 'invalid_assertion' }));
    const guard = new AdminAccessGuard(spyAdminGuard(true).guard, operators);

    const { ctx } = contextWith({ 'x-admin-token': GOOD_TOKEN, 'x-operator-assertion': 'garbage' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong operator token even with a genuine assertion', async () => {
    const operators = stubOperators(async () => ({ ok: true, operator: { id: 'op-1', email: 'op@tradew.io', name: null } }));
    const guard = new AdminAccessGuard(spyAdminGuard(true).guard, operators);

    const { ctx } = contextWith({ 'x-admin-token': 'wrong-token-of-the-right-sort-of-length', 'x-operator-assertion': 'signed' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when ADMIN_API_TOKEN is unset, even for a valid assertion', async () => {
    delete process.env.ADMIN_API_TOKEN;
    const operators = stubOperators(async () => ({ ok: true, operator: { id: 'op-1', email: 'op@tradew.io', name: null } }));
    const guard = new AdminAccessGuard(spyAdminGuard(true).guard, operators);

    const { ctx } = contextWith({ 'x-admin-token': 'anything', 'x-operator-assertion': 'signed' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminAccessGuard — the operator path, when both factors are good', () => {
  it('sets a resolvable, non-null attribution identity on req.user', async () => {
    const operators = stubOperators(async () => ({ ok: true, operator: { id: 'op-42', email: 'ops@tradew.io', name: 'Ops' } }));
    const guard = new AdminAccessGuard(spyAdminGuard(true).guard, operators);

    const { ctx, req } = contextWith({ 'x-admin-token': GOOD_TOKEN, 'x-operator-assertion': 'signed' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    // The whole reason the operator path exists: setAdmin/resolveProposal read
    // req.user.sub, and it must never be null. It is namespaced so nothing joins
    // it against the user table.
    expect(req.user).toMatchObject({ sub: 'operator:op-42', email: 'ops@tradew.io', isAdmin: true, operatorId: 'op-42' });
    expect((req.user as { sub: string }).sub).not.toBeNull();
  });

  it('answers a disabled account with Forbidden, not Unauthorized', async () => {
    const operators = stubOperators(async () => ({ ok: false, reason: 'account_disabled' }));
    const guard = new AdminAccessGuard(spyAdminGuard(true).guard, operators);

    const { ctx } = contextWith({ 'x-admin-token': GOOD_TOKEN, 'x-operator-assertion': 'signed-but-revoked' });
    // Revoked ≠ expired: the credential was real and the answer is still no, so
    // the console can tell an operator "your access was pulled" rather than
    // bouncing them through a re-login that will also fail.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
