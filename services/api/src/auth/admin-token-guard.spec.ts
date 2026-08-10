import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminTokenGuard } from './admin-token.guard';

/**
 * Pins the AdminTokenGuard's fail-closed behaviour after the 2026-08-10 fix.
 *
 * Before: the guard only checked that ADMIN_API_TOKEN was set — and the value
 * set was a live Anthropic key (`sk-ant-…`), which also equalled
 * ANTHROPIC_API_KEY. These tests assert that a structurally-invalid operator
 * secret disables the surface entirely, so a reused vendor key can never guard
 * the admin API even if someone pastes one back into .env.
 */

function contextFor(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

const guard = new AdminTokenGuard();
const VALID_TOKEN = 'A'.repeat(48); // 48-char dedicated secret

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ADMIN_API_TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = saved;
});

describe('AdminTokenGuard — the operator secret must be a real, dedicated secret', () => {
  it('disables the surface when ADMIN_API_TOKEN is unset', () => {
    delete process.env.ADMIN_API_TOKEN;
    expect(() => guard.canActivate(contextFor({ headers: { 'x-admin-token': 'anything' } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('disables the surface when ADMIN_API_TOKEN is a vendor key, even if the caller presents it correctly', () => {
    const anthropic = 'sk-ant-api03-' + 'z'.repeat(80);
    process.env.ADMIN_API_TOKEN = anthropic;
    // Caller presents the *exact* configured value — under the old code this
    // would have authenticated. It must now be refused because the configured
    // secret itself is structurally invalid.
    expect(() => guard.canActivate(contextFor({ headers: { 'x-admin-token': anthropic } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('disables the surface when ADMIN_API_TOKEN is a known placeholder', () => {
    process.env.ADMIN_API_TOKEN = 'dev-secret-change-me';
    expect(() => guard.canActivate(contextFor({ headers: { 'x-admin-token': 'dev-secret-change-me' } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong token when a strong secret is configured', () => {
    process.env.ADMIN_API_TOKEN = VALID_TOKEN;
    expect(() => guard.canActivate(contextFor({ headers: { 'x-admin-token': 'B'.repeat(48) } }))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the correct token when a strong secret is configured', () => {
    process.env.ADMIN_API_TOKEN = VALID_TOKEN;
    expect(guard.canActivate(contextFor({ headers: { 'x-admin-token': VALID_TOKEN } }))).toBe(true);
  });
});
