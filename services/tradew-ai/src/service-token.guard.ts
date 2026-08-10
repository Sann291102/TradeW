import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * The api→tradew-ai hop guard.
 *
 * Deliberately identical in behaviour to `services/sentinel`'s ServiceTokenGuard
 * (app.controller.ts) rather than a looser variant: two internal services with
 * two different definitions of "authenticated" is how one of them ends up being
 * the weak one. If that implementation is hardened, harden this in the same
 * commit.
 *
 * Fails CLOSED on an unset, placeholder or short token. A weak shared secret is
 * not a boundary, so the surface is disabled until a real value is configured
 * rather than being nominally guarded by a value that is public in the repo's
 * history — the exact failure the 2026-08-10 audit found with JWT_SECRET's
 * `|| 'dev-secret'` fallback.
 */
const WEAK_SERVICE_TOKENS = new Set([
  'dev-secret-change-me',
  'change-me',
  'changeme',
  'secret',
  'service-token',
  'tradew',
  'test',
]);

const MIN_TOKEN_LENGTH = 24;

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SERVICE_TOKEN ?? '';
    if (
      !expected ||
      expected.length < MIN_TOKEN_LENGTH ||
      WEAK_SERVICE_TOKENS.has(expected.toLowerCase())
    ) {
      throw new UnauthorizedException('SERVICE_TOKEN not configured');
    }

    const req = context.switchToHttp().getRequest();
    const presented = req.headers['x-service-token'];

    // Constant-time: the token does not rotate per request, so a
    // short-circuiting `!==` lets a network-adjacent caller recover it
    // byte-by-byte across many attempts.
    if (typeof presented !== 'string' || !constantTimeEquals(presented, expected)) {
      throw new UnauthorizedException('Invalid service token');
    }
    return true;
  }
}

/** timingSafeEqual throws on a length mismatch, so length is compared first. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
