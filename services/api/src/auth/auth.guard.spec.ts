import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';

/**
 * Bearer-token parsing — the gate in front of every authenticated route.
 *
 * `AuthGuard` is 20 lines and looks obviously correct, which is exactly why it
 * is worth pinning: it is applied per-controller with no `APP_GUARD` fallback,
 * so its behaviour is the whole of the authentication boundary for the routes
 * that carry it. The cases below fix the two decisions it makes — what counts
 * as a token, and what happens when verification fails — so neither can drift
 * into being more permissive without a test turning red.
 *
 * Structural stubs only, matching the guard suites in `broker/`: no Nest
 * application context, no JWT library, no network.
 */

function contextWith(authorization?: string): { ctx: ExecutionContext; req: { headers: Record<string, string>; user?: unknown } } {
  const req: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization === undefined ? {} : { authorization },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

/** Accepts exactly one token; anything else throws the way a real verify would. */
function stubJwt(validToken: string, payload: unknown): JwtService {
  return {
    verify(token: string) {
      if (token !== validToken) throw new Error('invalid signature');
      return payload;
    },
  } as unknown as JwtService;
}

describe('AuthGuard — accepting a valid token', () => {
  it('attaches the decoded payload to req.user and allows the request', () => {
    const guard = new AuthGuard(stubJwt('good-token', { sub: 'user-1', email: 'a@b.c' }));
    const { ctx, req } = contextWith('Bearer good-token');

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.user).toEqual({ sub: 'user-1', email: 'a@b.c' });
  });

  it('preserves a token containing dots and dashes exactly as sent', () => {
    const jwtish = 'eyJhbGci.eyJzdWIi.sig-part_1';
    const guard = new AuthGuard(stubJwt(jwtish, { sub: 'user-2' }));
    const { ctx, req } = contextWith(`Bearer ${jwtish}`);

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.user).toEqual({ sub: 'user-2' });
  });
});

describe('AuthGuard — rejecting a missing or malformed header', () => {
  const guard = () => new AuthGuard(stubJwt('good-token', { sub: 'user-1' }));

  it('rejects a request with no Authorization header', () => {
    const { ctx } = contextWith(undefined);
    expect(() => guard().canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard().canActivate(ctx)).toThrow('Missing bearer token');
  });

  it('rejects an empty Authorization header', () => {
    const { ctx } = contextWith('');
    expect(() => guard().canActivate(ctx)).toThrow('Missing bearer token');
  });

  it('rejects a bare token with no scheme', () => {
    const { ctx } = contextWith('good-token');
    expect(() => guard().canActivate(ctx)).toThrow('Missing bearer token');
  });

  it('rejects a non-Bearer scheme even when the credential is valid', () => {
    const { ctx } = contextWith('Basic good-token');
    expect(() => guard().canActivate(ctx)).toThrow('Missing bearer token');
  });

  it('is case-sensitive on the scheme — "bearer" is not accepted', () => {
    // Pinning current behaviour rather than endorsing it: RFC 6750 says the
    // scheme is case-insensitive. If this is ever relaxed it should be a
    // deliberate change with this test updated, not an accident.
    const { ctx } = contextWith('bearer good-token');
    expect(() => guard().canActivate(ctx)).toThrow('Missing bearer token');
  });

  it('rejects the scheme with no credential after it', () => {
    // 'Bearer ' slices to '' — falsy, so it must not reach verify().
    const { ctx } = contextWith('Bearer ');
    expect(() => guard().canActivate(ctx)).toThrow('Missing bearer token');
  });
});

describe('AuthGuard — rejecting a token that fails verification', () => {
  it('translates a verify() throw into 401 Invalid token', () => {
    const guard = new AuthGuard(stubJwt('good-token', { sub: 'user-1' }));
    const { ctx } = contextWith('Bearer forged-token');

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow('Invalid token');
  });

  it('does not populate req.user when verification fails', () => {
    const guard = new AuthGuard(stubJwt('good-token', { sub: 'user-1' }));
    const { ctx, req } = contextWith('Bearer forged-token');

    expect(() => guard.canActivate(ctx)).toThrow();
    expect(req.user).toBeUndefined();
  });

  it('distinguishes a malformed header from a rejected token in its message', () => {
    // The two failures are operationally different — one is a client that
    // never sent credentials, the other is a client whose credentials were
    // refused — and the messages must stay distinguishable in logs.
    const guard = new AuthGuard(stubJwt('good-token', { sub: 'user-1' }));
    expect(() => guard.canActivate(contextWith(undefined).ctx)).toThrow('Missing bearer token');
    expect(() => guard.canActivate(contextWith('Bearer nope').ctx)).toThrow('Invalid token');
  });

  it('surfaces an expired token as Invalid token, never as success', () => {
    const expiring = {
      verify() {
        const err = new Error('jwt expired');
        err.name = 'TokenExpiredError';
        throw err;
      },
    } as unknown as JwtService;
    const guard = new AuthGuard(expiring);
    const { ctx, req } = contextWith('Bearer expired-token');

    expect(() => guard.canActivate(ctx)).toThrow('Invalid token');
    expect(req.user).toBeUndefined();
  });
});
