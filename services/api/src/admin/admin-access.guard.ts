import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { securityLog } from '../common/security-log';
import { isSecretAcceptable } from '../common/secret-validation';
import { AdminGuard } from './admin.guard';
import { OperatorService } from './operator/operator.service';

/**
 * The gate on `AdminController`. Two ways in, and the operator token is
 * required on both while being sufficient on neither.
 *
 *   AdminAccessGuard
 *   ├─ ADMIN_API_TOKEN                          REQUIRED on both paths
 *   └─ then exactly one of:
 *      ├─ product-admin   Bearer JWT → User.isAdmin   (apps/web — delegated
 *      │                                               verbatim to AdminGuard)
 *      └─ operator        x-operator-assertion → OperatorAccount.disabledAt IS NULL
 *                                                     (apps/admin)
 *
 * WHY A COMPOSED GUARD RATHER THAN A WIDER `AdminGuard`
 *
 * The obvious shape — teach `AdminGuard` to accept the operator token when no
 * JWT is present — was rejected, and for a specific reason rather than a
 * stylistic one. `AdminGuard` protects every route on the admin surface; a
 * branch added there to serve one client silently becomes a second
 * authentication mechanism for all of them, and the reviewer of any future
 * admin route has no way to see it. Here the product-admin path is not
 * re-implemented, re-tested, or even read: it is `AdminGuard.canActivate`,
 * called unmodified. If the operator branch has a bug it cannot reach
 * `apps/web`.
 *
 * WHICH PATH RUNS IS DECIDED BY THE PRESENCE OF THE ASSERTION HEADER, NOT BY
 * FALLBACK. A request with no assertion is a product-admin request and is held
 * to that standard even if it fails; it never "falls back" to the weaker check.
 * A request with a bad assertion is denied outright rather than being retried
 * as a product-admin request — otherwise a caller could probe both paths with
 * one request and the logs would not distinguish them.
 *
 * NO HEADER CONFERS TRUST. There is deliberately no `X-Admin-Proxy`,
 * no trusted `X-Forwarded-For`, no allowlisted internal hostname. Any client
 * that can reach this API can set any header it likes, so a header can only ever
 * carry a credential to be verified — never, by its presence, an assertion that
 * the caller is trustworthy. The trust here comes from a secret the caller must
 * possess (`ADMIN_API_TOKEN`), a signature this process alone can produce
 * (`OPERATOR_JWT_SECRET`), and the API not being internet-exposed by default.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    private readonly productAdmin: AdminGuard,
    private readonly operators: OperatorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const assertion = req.headers?.['x-operator-assertion'];

    // No operator assertion → this is `apps/web`'s in-product console. Hand the
    // whole decision to the existing guard, unchanged and unwrapped: it does its
    // own operator-token check, its own JWT verification, its own database
    // `isAdmin` lookup and its own denial logging.
    if (typeof assertion !== 'string' || assertion.length === 0) {
      return this.productAdmin.canActivate(context);
    }

    const ip = req.ip ?? null;
    const userAgent = req.headers?.['user-agent'] ?? null;
    const deny = (event: string, detail: Record<string, unknown> = {}) => {
      securityLog({ event, outcome: 'denied', ip, userAgent, detail: { path: req.url, ...detail } });
    };

    // Factor 1, and it is checked FIRST for the same reason `AdminGuard` checks
    // it first: a constant-time string compare with no database round-trip, so
    // an unauthorised prober never reaches a query. The operator path does NOT
    // honour the SSE query-parameter fallback — `EventSource` is the only reason
    // that fallback exists, and the standalone console proxies its streams
    // server-side where headers are available.
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected || !isSecretAcceptable(expected, { minLength: 24 })) {
      deny('admin.operator.unconfigured', { reason: expected ? 'weak_or_vendor_token' : 'unset' });
      throw new UnauthorizedException('Admin portal disabled (ADMIN_API_TOKEN not configured)');
    }

    const presented = req.headers?.['x-admin-token'];
    if (typeof presented !== 'string' || !constantTimeEquals(presented, expected)) {
      deny('admin.operator.token_denied', { presented: typeof presented === 'string' });
      throw new UnauthorizedException('Invalid admin token');
    }

    // Factor 2: which person. Verifies the signature under a key that never
    // leaves this process, then re-reads the account so revocation takes effect
    // on the next request rather than at assertion expiry.
    const verdict = await this.operators.verifyAssertion(assertion);
    if (!verdict.ok) {
      deny('admin.operator.assertion_denied', { reason: verdict.reason });
      // `account_disabled` is a Forbidden, not an Unauthorized: the credential
      // was genuine and the answer is still no. Conflating the two would make
      // "your access was revoked" indistinguishable from "your session expired"
      // in the console, and operators would keep re-logging-in against a wall.
      throw verdict.reason === 'account_disabled'
        ? new ForbiddenException('Operator account is disabled')
        : new UnauthorizedException('Invalid operator assertion');
    }

    // Shaped exactly like the product-admin path's `req.user`, so every handler
    // downstream is oblivious to which door the request came through. `sub` is
    // prefixed because it is NOT a `User.id` and nothing should ever join it
    // against the user table — but it is a real, resolvable identity, which is
    // the whole point: `setAdmin` and `resolveProposal` record who acted.
    req.user = {
      sub: `operator:${verdict.operator.id}`,
      email: verdict.operator.email,
      isAdmin: true,
      operatorId: verdict.operator.id,
    };

    this.operators.touch(verdict.operator.id);
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
