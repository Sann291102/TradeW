import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { securityLog } from '../common/security-log';

/**
 * Operator-only endpoints, gated by the static `ADMIN_API_TOKEN`.
 *
 * Moved here from `entitlements.controller.ts`, where it was declared inline, so
 * that the broker module can gate operator actions with the SAME check rather
 * than inventing a second admin concept. `EntitlementsController` re-exports it
 * for backward compatibility, so no existing import path breaks.
 *
 * Two changes from the inline version:
 *
 *  · Comparison is `timingSafeEqual` rather than `!==`. A plain string compare
 *    on a static shared secret short-circuits at the first differing byte, which
 *    is the one place in this codebase where a remote attacker really can search
 *    a secret byte-by-byte: the token never rotates, so an attacker can average
 *    over unlimited requests.
 *  · Denials are written to the security log, so repeated probing of the admin
 *    surface is visible.
 *
 * This is a shared-secret check, not a user identity: it authorizes "the
 * operator" as a role and carries no `userId`. Anything that needs to act as a
 * specific user must use `AuthGuard` instead.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const expected = process.env.ADMIN_API_TOKEN;

    // Fail closed. An unset token disables the admin surface rather than
    // allowing it — the opposite default would turn a missing env var into an
    // open operator API.
    if (!expected) {
      securityLog({
        event: 'admin.auth.unconfigured',
        outcome: 'denied',
        ip: req.ip ?? null,
        userAgent: req.headers?.['user-agent'] ?? null,
        detail: { path: req.url },
      });
      throw new UnauthorizedException('Admin API disabled (ADMIN_API_TOKEN not configured)');
    }

    const presented = req.headers?.['x-admin-token'];
    if (typeof presented !== 'string' || !constantTimeEquals(presented, expected)) {
      securityLog({
        event: 'admin.auth.denied',
        outcome: 'denied',
        ip: req.ip ?? null,
        userAgent: req.headers?.['user-agent'] ?? null,
        detail: { path: req.url, presented: typeof presented === 'string' },
      });
      throw new UnauthorizedException('Invalid admin token');
    }
    return true;
  }
}

/** `timingSafeEqual` throws unless both buffers are the same length, so length
 *  is checked first. Length is not itself a secret here — the token's length is
 *  chosen by the operator, not derived from its value. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
