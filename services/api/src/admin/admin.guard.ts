import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { securityLog } from '../common/security-log';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The gate on every admin-portal endpoint.
 *
 * Two independent factors, both required:
 *
 *  1. A valid user JWT whose user row has `isAdmin = true`. Checked against the
 *     DATABASE on every request, never from a claim inside the token. A claim
 *     would mean revoking someone's access does nothing until their token
 *     expires — for a surface that exposes every user's activity, a week-long
 *     window between "revoked" and "actually revoked" is not acceptable.
 *  2. The operator shared secret `ADMIN_API_TOKEN`, the same one
 *     `AdminTokenGuard` enforces on the pre-existing operator endpoints.
 *
 * Requiring both means neither a stolen session nor a leaked env var is
 * sufficient on its own. The second factor also gives the portal a hard
 * dependency on something that is never present in a browser by default: an
 * ordinary signed-in user who guesses the URL cannot reach the API even if the
 * `isAdmin` check were somehow wrong.
 *
 * Every denial is written to the security log. This surface WILL be probed, and
 * the probing is the signal.
 *
 * Fails closed on an unset `ADMIN_API_TOKEN` — an unconfigured deployment has
 * no admin API at all, rather than an open one.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = req.ip ?? null;
    const userAgent = req.headers?.['user-agent'] ?? null;
    const deny = (event: string, detail: Record<string, unknown> = {}) => {
      securityLog({ event, outcome: 'denied', ip, userAgent, detail: { path: req.url, ...detail } });
    };

    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected) {
      deny('admin.portal.unconfigured');
      throw new UnauthorizedException('Admin portal disabled (ADMIN_API_TOKEN not configured)');
    }

    // Factor 2 first: it is a constant-time string compare with no database
    // round-trip, so an unauthorised prober never reaches the user lookup.
    //
    // The query-param fallback exists for SSE routes under /admin (currently
    // `GET /admin/stream` and `GET /admin/knowledge/stream`): `EventSource`
    // cannot set request headers, so an SSE subscriber has no way to present
    // credentials otherwise. It is narrowed to an explicit allowlist of paths
    // rather than allowed everywhere, because credentials in a URL end up in
    // access logs, proxy logs and browser history — acceptable for a small,
    // read-only set of streams, not as a general authentication mode.
    const ADMIN_SSE_ROUTES = new Set(['/admin/stream', '/admin/knowledge/stream']);
    const requestPath = typeof req.url === 'string' ? req.url.split('?')[0] : '';
    const streamRoute = ADMIN_SSE_ROUTES.has(requestPath);
    const presented = req.headers?.['x-admin-token'] ?? (streamRoute ? req.query?.admin_token : undefined);
    if (typeof presented !== 'string' || !constantTimeEquals(presented, expected)) {
      deny('admin.portal.token_denied', { presented: typeof presented === 'string' });
      throw new UnauthorizedException('Invalid admin token');
    }

    const header = req.headers?.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : streamRoute && typeof req.query?.access_token === 'string'
        ? req.query.access_token
        : null;
    if (!token) {
      deny('admin.portal.no_session');
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims: { sub?: string };
    try {
      claims = this.jwt.verify(token);
    } catch {
      deny('admin.portal.bad_session');
      throw new UnauthorizedException('Invalid token');
    }

    const user = claims.sub
      ? await this.prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, isAdmin: true } })
      : null;

    if (!user?.isAdmin) {
      // Logged at a distinct event from the token failures above: this is a
      // real, authenticated user reaching for a surface they do not have, which
      // is a materially different thing from an anonymous prober.
      deny('admin.portal.not_admin', { userId: claims.sub ?? null });
      throw new ForbiddenException('Not an admin');
    }

    req.user = { ...claims, isAdmin: true, email: user.email };
    return true;
  }
}

/** Length-checked first because `timingSafeEqual` throws on a mismatch. The
 *  token's length is operator-chosen, not secret-derived. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
