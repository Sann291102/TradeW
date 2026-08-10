import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminTokenGuard } from '../auth/admin-token.guard';
import { AuthGuard } from '../auth/auth.guard';
import { DhanAuthController } from './dhan-auth.controller';
import { denyCrossUserAccess, type DhanCredentialStatus } from './dhan-auth.service';

/**
 * Authorization on the broker surface.
 *
 * The previous implementation gated `/connect` and `/status` behind a bare
 * `AuthGuard` with no ownership check and served a single global credential row,
 * so "any authenticated user" and "the operator" were the same authorization
 * level. These tests pin the three distinctions that replaced that: authenticated
 * vs. anonymous, own-credential vs. another user's, and user vs. operator.
 */

/** Minimal ExecutionContext — the guards only ever reach for the HTTP request. */
function contextFor(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('AuthGuard — anonymous access to broker routes', () => {
  const guard = new AuthGuard({ verify: () => ({ sub: 'user-alice' }) } as never);

  it('rejects a request with no Authorization header', () => {
    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization header', () => {
    expect(() => guard.canActivate(contextFor({ headers: { authorization: 'Basic abc' } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token the JWT service will not verify', () => {
    const rejecting = new AuthGuard({
      verify: () => {
        throw new Error('bad signature');
      },
    } as never);
    expect(() =>
      rejecting.canActivate(contextFor({ headers: { authorization: 'Bearer forged' } })),
    ).toThrow(UnauthorizedException);
  });

  it('admits a verified token and attaches the subject', () => {
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer good' } };
    expect(guard.canActivate(contextFor(req))).toBe(true);
    expect(req.user).toEqual({ sub: 'user-alice' });
  });
});

describe('AdminTokenGuard — operator-only broker routes', () => {
  const original = process.env.ADMIN_API_TOKEN;
  beforeEach(() => {
    process.env.ADMIN_API_TOKEN = 'operator-secret-value-32chars-long!';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = original;
  });

  const guard = new AdminTokenGuard();

  it('rejects a request with no admin token — a user bearer token is not enough', () => {
    expect(() =>
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer valid-user-token' }, url: '/broker/dhan/admin/credentials' }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a wrong admin token', () => {
    expect(() =>
      guard.canActivate(contextFor({ headers: { 'x-admin-token': 'guess' }, url: '/x' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a token that is a prefix of the real one', () => {
    // Length is checked before the constant-time compare; a prefix must not pass.
    expect(() =>
      guard.canActivate(contextFor({ headers: { 'x-admin-token': 'operator-secret' }, url: '/x' })),
    ).toThrow(UnauthorizedException);
  });

  it('accepts the correct admin token', () => {
    expect(
      guard.canActivate(contextFor({ headers: { 'x-admin-token': 'operator-secret-value-32chars-long!' }, url: '/x' })),
    ).toBe(true);
  });

  it('fails closed when ADMIN_API_TOKEN is not configured', () => {
    delete process.env.ADMIN_API_TOKEN;
    // An unset secret must disable the admin surface, never open it.
    expect(() =>
      guard.canActivate(contextFor({ headers: { 'x-admin-token': 'anything' }, url: '/x' })),
    ).toThrow(UnauthorizedException);
  });
});

describe('cross-user credential access', () => {
  const connected: DhanCredentialStatus = {
    connected: true,
    brokerClientId: 'DHAN-ALICE',
    brokerClientName: 'Alice',
    expiresAt: null,
    expired: false,
    source: 'consent',
    isFeedDefault: false,
  };

  function controllerFor(statusSpy = vi.fn(async () => connected)) {
    const service = { status: statusSpy } as never;
    return { controller: new DhanAuthController(service), statusSpy };
  }

  const aliceReq = { user: { sub: 'user-alice' }, headers: {}, ip: '127.0.0.1' } as never;

  it('reads the caller\'s own credential from the token subject', async () => {
    const { controller, statusSpy } = controllerFor();
    await controller.status(aliceReq);
    expect(statusSpy).toHaveBeenCalledWith('user-alice');
  });

  it('refuses when the caller names a different user', () => {
    const { controller, statusSpy } = controllerFor();
    expect(() => controller.status(aliceReq, 'user-bob')).toThrow(ForbiddenException);
    // The critical assertion: the lookup never ran with the attacker-supplied id.
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('allows a matching userId echo', async () => {
    const { controller, statusSpy } = controllerFor();
    await controller.status(aliceReq, 'user-alice');
    expect(statusSpy).toHaveBeenCalledWith('user-alice');
  });

  it('denyCrossUserAccess always throws Forbidden and never returns', () => {
    expect(() => denyCrossUserAccess('user-alice', 'user-bob')).toThrow(ForbiddenException);
  });
});
