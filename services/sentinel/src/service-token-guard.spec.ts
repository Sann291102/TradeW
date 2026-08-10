import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceTokenGuard } from './app.controller';

/**
 * Pins the internal api→sentinel channel's fail-closed behaviour after the
 * 2026-08-10 assessment. Before: SERVICE_TOKEN's committed dev value was
 * `dev-sentinel-token`, accepted as-is, and compared with a short-circuiting
 * `!==`. These tests assert a placeholder/short value disables the surface and
 * the compare is length-guarded.
 */

function contextFor(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

const guard = new ServiceTokenGuard();
const STRONG = 'S'.repeat(40);

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.SERVICE_TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SERVICE_TOKEN;
  else process.env.SERVICE_TOKEN = saved;
});

describe('ServiceTokenGuard — internal service auth fails closed on a weak secret', () => {
  it('rejects when SERVICE_TOKEN is unset', () => {
    delete process.env.SERVICE_TOKEN;
    expect(() => guard.canActivate(contextFor({ headers: { 'x-service-token': 'anything' } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects the committed dev placeholder even if presented correctly', () => {
    process.env.SERVICE_TOKEN = 'dev-sentinel-token';
    expect(() => guard.canActivate(contextFor({ headers: { 'x-service-token': 'dev-sentinel-token' } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a too-short token', () => {
    process.env.SERVICE_TOKEN = 'short-token';
    expect(() => guard.canActivate(contextFor({ headers: { 'x-service-token': 'short-token' } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong token when a strong secret is configured', () => {
    process.env.SERVICE_TOKEN = STRONG;
    expect(() => guard.canActivate(contextFor({ headers: { 'x-service-token': 'T'.repeat(40) } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the correct token when a strong secret is configured', () => {
    process.env.SERVICE_TOKEN = STRONG;
    expect(guard.canActivate(contextFor({ headers: { 'x-service-token': STRONG } }))).toBe(true);
  });
});
