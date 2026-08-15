import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { isSecretAcceptable } from '../../common/secret-validation';
import { securityLog } from '../../common/security-log';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The standalone admin console's identity layer.
 *
 * WHY THIS EXISTS AT ALL
 *
 * `apps/admin` is a server-rendered console whose Route Handlers hold
 * `ADMIN_API_TOKEN` and call this API on the browser's behalf. That token proves
 * the calling *process* is the admin deployment. It cannot prove a person is
 * present, and it cannot prove *which* person — so on its own it is not enough
 * to authorise `POST /admin/users/set-admin` or
 * `POST /admin/cognition/proposals/:id/resolve`, both of which write an actor
 * into a record someone will later have to read.
 *
 * An `OperatorAccount` supplies the missing half. The console logs an operator
 * in here, receives a short assertion naming that account, and presents it on
 * every subsequent call alongside the operator token. `AdminAccessGuard`
 * requires both.
 *
 * WHY THE ASSERTION IS NOT SIGNED WITH `JWT_SECRET`
 *
 * This is the load-bearing detail. `AuthGuard` (auth/auth.guard.ts) does
 * `req.user = this.jwt.verify(token)` and accepts whatever claims come back —
 * it makes no assertion about token *shape*. An operator assertion signed with
 * the product's `JWT_SECRET` would therefore be a valid bearer token on every
 * authenticated route in the product, with `sub` set to something that is not a
 * user id. Minting operator credentials would silently mint product
 * credentials. `OPERATOR_JWT_SECRET` is a separate key so that cannot happen,
 * and the `typ: 'operator'` claim is checked on verify so a token of any other
 * shape is rejected even under the right key.
 *
 * WHY THE SIGNING KEY IS NOT DERIVED FROM `ADMIN_API_TOKEN`
 *
 * It would be convenient — one secret to configure, and rotation would
 * invalidate every assertion for free. But `ADMIN_API_TOKEN` travels on the wire
 * in `x-admin-token` on every request, and (for the two SSE routes) in a query
 * string. A secret that is transmitted constantly is the wrong thing to sign
 * identities with: anyone who captured it from a proxy log could then mint an
 * assertion for any operator, which collapses the two factors back into one.
 * `OPERATOR_JWT_SECRET` never leaves this process.
 *
 * FAIL-CLOSED SHAPE
 *
 * Unset or weak `OPERATOR_JWT_SECRET` disables the operator path entirely —
 * login refuses and the guard rejects every assertion. It does NOT disable the
 * product-admin path, so a deployment that never wants standalone operators
 * simply leaves the variable unset and loses nothing.
 */

/** 12h — an operator shift, matching the console's session cookie TTL. A long
 *  TTL is safe here only because revocation does NOT depend on it: every request
 *  re-reads `disabledAt` from the database. */
const ASSERTION_TTL_SECONDS = 12 * 60 * 60;

/** Failed logins before the account is locked, and for how long. Generous
 *  enough that a mistyped password is not an incident, tight enough that
 *  guessing is not viable — and remember the login endpoint already sits behind
 *  `AdminTokenGuard`, so this brake applies to an attacker who ALREADY has the
 *  operator token. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface OperatorIdentity {
  id: string;
  email: string;
  name: string | null;
}

export interface OperatorLoginResult {
  assertion: string;
  expiresAtMs: number;
  operator: OperatorIdentity;
}

/** Why a login or an assertion was refused. Returned rather than thrown so the
 *  caller decides the HTTP shape, and so the reason can be logged without being
 *  told to the client — see `operator.controller.ts`, which collapses every one
 *  of these to the same message. */
export type OperatorDenial =
  | 'disabled_path'
  | 'unknown_account'
  | 'bad_password'
  | 'account_disabled'
  | 'locked_out'
  | 'invalid_assertion';

@Injectable()
export class OperatorService {
  private readonly logger = new Logger(OperatorService.name);
  /** Built lazily and cached: the secret is read at first use rather than at
   *  construction so a test (or an operator fixing their `.env`) can set it
   *  without restarting the Nest context. `null` means the path is off. */
  private signer: JwtService | null | undefined;
  private cachedSecret: string | undefined;

  constructor(private readonly prisma: PrismaService) {}

  /** True when this deployment has a usable operator-assertion key. */
  enabled(): boolean {
    return this.jwt() !== null;
  }

  private jwt(): JwtService | null {
    const secret = process.env.OPERATOR_JWT_SECRET;
    // Re-derive when the env value changes rather than trusting the cache
    // forever; cheap, and it keeps tests from leaking state into each other.
    if (this.signer !== undefined && this.cachedSecret === secret) return this.signer;
    this.cachedSecret = secret;
    if (!isSecretAcceptable(secret, { minLength: 32 })) {
      this.signer = null;
      return null;
    }
    this.signer = new JwtService({ secret });
    return this.signer;
  }

  /**
   * Verify credentials and mint an assertion.
   *
   * Every failure path costs roughly the same wall-clock time as a success:
   * an unknown email still runs a bcrypt comparison against a dummy hash, so
   * the response time does not reveal whether an operator account exists.
   */
  async login(
    email: string,
    password: string,
    ip: string | null,
  ): Promise<{ ok: true; result: OperatorLoginResult } | { ok: false; reason: OperatorDenial }> {
    const jwt = this.jwt();
    if (!jwt) {
      securityLog({ event: 'admin.operator.path_disabled', outcome: 'denied', ip, detail: { reason: 'OPERATOR_JWT_SECRET unset or weak' } });
      return { ok: false, reason: 'disabled_path' };
    }

    const account = await this.prisma.operatorAccount.findUnique({ where: { email: email.toLowerCase().trim() } });

    if (!account) {
      // Constant-ish work on the miss path. Without this, "no such operator"
      // returns in microseconds and "wrong password" takes ~100ms, which is a
      // free account-enumeration oracle for anyone holding the operator token.
      await bcrypt.compare(password, DUMMY_HASH);
      securityLog({ event: 'admin.operator.login_denied', outcome: 'denied', ip, detail: { reason: 'unknown_account' } });
      return { ok: false, reason: 'unknown_account' };
    }

    if (account.disabledAt) {
      securityLog({ event: 'admin.operator.login_denied', outcome: 'denied', userId: account.id, ip, detail: { reason: 'account_disabled' } });
      return { ok: false, reason: 'account_disabled' };
    }

    if (account.lockedUntil && account.lockedUntil.getTime() > Date.now()) {
      securityLog({ event: 'admin.operator.login_denied', outcome: 'denied', userId: account.id, ip, detail: { reason: 'locked_out' } });
      return { ok: false, reason: 'locked_out' };
    }

    if (!(await bcrypt.compare(password, account.passwordHash))) {
      const failed = account.failedAttempts + 1;
      await this.prisma.operatorAccount.update({
        where: { id: account.id },
        data: {
          failedAttempts: failed,
          lockedUntil: failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : account.lockedUntil,
        },
      });
      securityLog({
        event: 'admin.operator.login_denied',
        outcome: 'denied',
        userId: account.id,
        ip,
        detail: { reason: 'bad_password', failedAttempts: failed, locked: failed >= MAX_FAILED_ATTEMPTS },
      });
      return { ok: false, reason: 'bad_password' };
    }

    await this.prisma.operatorAccount.update({
      where: { id: account.id },
      data: { failedAttempts: 0, lockedUntil: null, lastSeenAt: new Date(), lastLoginIp: ip },
    });

    const expiresAtMs = Date.now() + ASSERTION_TTL_SECONDS * 1000;
    const assertion = jwt.sign(
      { typ: 'operator', sub: account.id, email: account.email },
      { expiresIn: ASSERTION_TTL_SECONDS },
    );

    securityLog({ event: 'admin.operator.login', outcome: 'success', userId: account.id, ip });
    this.logger.log(`operator ${account.email} signed in`);

    return {
      ok: true,
      result: { assertion, expiresAtMs, operator: { id: account.id, email: account.email, name: account.name } },
    };
  }

  /**
   * Verify an assertion and re-check the account behind it.
   *
   * The database read is not an optimisation to be cached away. It is the
   * revocation mechanism: `disabledAt` set in one place must deny the next
   * request everywhere, rather than waiting up to 12h for an assertion to
   * expire. The same reasoning already governs `User.isAdmin` in `AdminGuard`.
   */
  async verifyAssertion(
    assertion: string,
  ): Promise<{ ok: true; operator: OperatorIdentity } | { ok: false; reason: OperatorDenial }> {
    const jwt = this.jwt();
    if (!jwt) return { ok: false, reason: 'disabled_path' };

    let claims: { typ?: string; sub?: string };
    try {
      claims = jwt.verify(assertion);
    } catch {
      return { ok: false, reason: 'invalid_assertion' };
    }

    // Shape check. A token signed with the right key but minted for some other
    // purpose is still not an operator assertion, and this is the claim that
    // says so.
    if (claims.typ !== 'operator' || !claims.sub) return { ok: false, reason: 'invalid_assertion' };

    const account = await this.prisma.operatorAccount.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, name: true, disabledAt: true },
    });

    if (!account) return { ok: false, reason: 'unknown_account' };
    if (account.disabledAt) return { ok: false, reason: 'account_disabled' };

    return { ok: true, operator: { id: account.id, email: account.email, name: account.name } };
  }

  /** Fire-and-forget liveness stamp, so the console can show who is currently
   *  on. Never awaited by the guard — a write failure must not deny a request
   *  that was otherwise authorised. */
  touch(operatorId: string): void {
    this.prisma.operatorAccount
      .update({ where: { id: operatorId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }
}

/** A real bcrypt hash of a value nothing will ever submit, used only to spend
 *  the same time on the unknown-account path as on the wrong-password one. */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
