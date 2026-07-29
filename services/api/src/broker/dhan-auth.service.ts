import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { securityLog } from '../common/security-log';
import {
  createState,
  rejectionMessage,
  resolvePendingState,
  STATE_TTL_MS,
  type PendingStateRow,
  type StateRejection,
} from './oauth-state';

/**
 * Dhan app-key authentication (the "consent" flow).
 *
 * Replaces pasting a hand-generated access token into
 * services/market-data/.env. Three steps, per DhanHQ's authentication docs
 * (verified 2026-07-29):
 *
 *   1. POST auth.dhan.co/app/generate-consent?client_id={dhanClientId}
 *      headers app_id + app_secret            -> { consentAppId }
 *   2. Browser -> auth.dhan.co/login/consentApp-login?consentAppId={id}
 *      user completes 2FA, Dhan redirects to the registered Redirect URL
 *      with ?tokenId={...}
 *   3. POST auth.dhan.co/app/consumeApp-consent?tokenId={tokenId}
 *      headers app_id + app_secret            -> { accessToken, expiryTime, ... }
 *
 * WHAT THIS DOES NOT DO: produce a permanent credential. Dhan's token is valid
 * for 24 hours regardless of how it was obtained. The win is that renewing it
 * becomes a request rather than a manual file edit and restart.
 *
 * ── SECURITY MODEL (rewritten 2026-07-29) ──────────────────────────────────
 *
 * The original version of this service stored ONE global credential row keyed
 * only by `provider`, and every method resolved it by that key alone. Combined
 * with a public callback that required no proof a flow had been started, that
 * meant any request completing a consent redirect overwrote the credential the
 * whole platform runs on, and any authenticated user could read the operator's
 * broker identity. Three things changed:
 *
 *  1. OWNERSHIP. Credentials are keyed (provider, userId). Every method here
 *     takes the acting `userId` and scopes its query to it. There is no method
 *     that reads or writes a credential by provider alone — except
 *     `currentAccessToken`, which is the deliberate, documented exception for
 *     the shared feed bridge and reads only the explicitly-designated
 *     `isFeedDefault` row.
 *
 *  2. STATE. `startConsent` mints a CSPRNG state bound to the authenticated
 *     caller; `consumeConsent` refuses any callback that does not match a live,
 *     unconsumed, unexpired state. The credential is attributed to the state
 *     row's user — never to anything in the callback request. See
 *     `oauth-state.ts` for the full threat model.
 *
 *  3. SINGLE USE. State consumption is a conditional UPDATE that runs BEFORE
 *     the token exchange, so a replayed callback loses the race and exchanges
 *     nothing. Burning the state on a failed exchange is the safe direction:
 *     the cost is one restart of a flow the user can retry at will.
 *
 * Still outstanding and NOT fixed here: `accessToken` is plaintext at rest.
 * That needs a key-management decision, not a code edit; see the column comment
 * in schema.prisma.
 */

const DHAN_AUTH = process.env.DHAN_AUTH_URL || 'https://auth.dhan.co';
const PROVIDER = 'dhan';
const TIMEOUT_MS = 15_000;

/**
 * When true, a callback with no `state` parameter is refused outright.
 *
 * Default false because Dhan's documented redirect carries only `tokenId` and
 * the redirect URL is registered (so we cannot vary it per request) — defaulting
 * this to true would break the flow on day one. The fallback path it enables is
 * still authenticated-initiated, user-bound and single-use; it only loses the
 * ability to disambiguate concurrent flows, which it refuses rather than guesses.
 * Operators who confirm their redirect preserves the parameter should set this.
 */
const REQUIRE_STATE = process.env.BROKER_OAUTH_REQUIRE_STATE === 'true';

export interface DhanCredentialStatus {
  connected: boolean;
  brokerClientId: string | null;
  brokerClientName: string | null;
  expiresAt: string | null;
  /** True when a token exists but Dhan's own expiry has passed. */
  expired: boolean;
  source: string | null;
  /** Whether this credential is the one the shared feed bridge runs on. */
  isFeedDefault: boolean;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const DISCONNECTED: DhanCredentialStatus = {
  connected: false,
  brokerClientId: null,
  brokerClientName: null,
  expiresAt: null,
  expired: false,
  source: null,
  isFeedDefault: false,
};

@Injectable()
export class DhanAuthService {
  private readonly logger = new Logger(DhanAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  private credentials(): { appId: string; appSecret: string; clientId: string } {
    const appId = process.env.DHAN_APP_ID;
    const appSecret = process.env.DHAN_APP_SECRET;
    const clientId = process.env.DHAN_CLIENT_ID;
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException(
        'DHAN_APP_ID and DHAN_APP_SECRET are not configured. Add them to services/api/.env.',
      );
    }
    if (!clientId) {
      throw new ServiceUnavailableException('DHAN_CLIENT_ID is not configured.');
    }
    return { appId, appSecret, clientId };
  }

  private async post<T>(path: string): Promise<T> {
    const { appId, appSecret } = this.credentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${DHAN_AUTH}${path}`, {
        method: 'POST',
        headers: { app_id: appId, app_secret: appSecret, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as T & { status?: string; message?: string };
      if (!res.ok) {
        throw new BadGatewayException(
          `Dhan auth returned ${res.status}${body?.message ? `: ${body.message}` : ''}`,
        );
      }
      return body as T;
    } catch (err) {
      if (err instanceof BadGatewayException || err instanceof ServiceUnavailableException) throw err;
      throw new BadGatewayException(`Dhan auth unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Step 1 + 2 — mint a consent id and hand back the URL the user must open.
   * The browser step cannot be automated: it requires the account's own 2FA,
   * which is the entire point of the consent model.
   *
   * SECURITY: this is the only place a state is created, and it requires an
   * authenticated `userId`. The state row is the record that binds the eventual
   * callback to this caller — without it, the callback has nothing to match and
   * is refused.
   */
  async startConsent(
    userId: string,
    meta: RequestMeta = {},
  ): Promise<{ consentAppId: string; loginUrl: string; state: string; expiresInMs: number }> {
    const { clientId } = this.credentials();

    // Best-effort housekeeping. Expired states are already refused on merit; this
    // just stops the table growing without bound, and keeps the
    // "exactly one live flow" fallback from being polluted by stale rows.
    await this.sweepExpiredStates();

    const body = await this.post<{ consentAppId?: string; consentAppStatus?: string }>(
      `/app/generate-consent?client_id=${encodeURIComponent(clientId)}`,
    );
    if (!body.consentAppId) {
      securityLog({
        event: 'broker.oauth.consent_start_failed',
        outcome: 'failure',
        userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { provider: PROVIDER, reason: 'no_consent_app_id' },
      });
      throw new BadGatewayException('Dhan did not return a consentAppId');
    }

    const { state, stateHash } = createState();
    await this.prisma.brokerOAuthState.create({
      data: {
        provider: PROVIDER,
        userId,
        stateHash,
        consentAppId: body.consentAppId,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
        ip: meta.ip ?? undefined,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : undefined,
      },
    });

    securityLog({
      event: 'broker.oauth.consent_started',
      outcome: 'success',
      userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: { provider: PROVIDER, consentAppId: body.consentAppId, expiresInMs: STATE_TTL_MS },
    });

    // `state` is appended to the login URL as well as returned to the caller.
    // Dhan is not documented to echo it back, so nothing DEPENDS on this — it is
    // free to include, and the strict path (BROKER_OAUTH_REQUIRE_STATE) becomes
    // available for any provider that does preserve it.
    const loginUrl =
      `${DHAN_AUTH}/login/consentApp-login?consentAppId=${encodeURIComponent(body.consentAppId)}` +
      `&state=${encodeURIComponent(state)}`;

    return { consentAppId: body.consentAppId, loginUrl, state, expiresInMs: STATE_TTL_MS };
  }

  /**
   * Step 3 — exchange the tokenId Dhan appended to the redirect for a real
   * access token, and persist it against the user who started the flow.
   *
   * SECURITY: the caller of this method is UNAUTHENTICATED (see the controller
   * on why the callback cannot require a bearer token), so nothing in `input` is
   * trusted for authorization. The owning user comes from the matched state row
   * and from nowhere else.
   *
   * @throws BadRequestException with a stable `reason` when state validation
   *         fails. The message is non-revealing: it names the rule that failed,
   *         never the values involved.
   */
  async consumeConsent(input: {
    tokenId: string;
    candidateState?: string | null;
    meta?: RequestMeta;
  }): Promise<{ status: DhanCredentialStatus; userId: string }> {
    const meta = input.meta ?? {};
    const now = new Date();

    // Load the full recent window INCLUDING consumed and expired rows, so the
    // resolver can tell replay from unknown. Bounded by the TTL so this stays a
    // small, indexed read.
    const rows = (await this.prisma.brokerOAuthState.findMany({
      where: { provider: PROVIDER, createdAt: { gte: new Date(now.getTime() - STATE_TTL_MS * 6) } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })) as PendingStateRow[];

    const resolution = resolvePendingState({
      rows,
      provider: PROVIDER,
      candidateState: input.candidateState,
      now,
      requireState: REQUIRE_STATE,
    });

    if (!resolution.ok) {
      this.logStateRejection(resolution.reason, meta, input.candidateState);
      throw new BadRequestException(rejectionMessage(resolution.reason));
    }

    const stateRow = resolution.row;

    // Single-use, enforced as a conditional UPDATE rather than a read-then-write.
    // Two concurrent callbacks presenting the same state both pass the resolver
    // above; exactly one wins this update. Consuming BEFORE the exchange means
    // the loser cannot exchange the tokenId at all.
    const claimed = await this.prisma.brokerOAuthState.updateMany({
      where: { id: stateRow.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count === 0) {
      this.logStateRejection('state_replayed', meta, input.candidateState, stateRow.userId);
      throw new BadRequestException(rejectionMessage('state_replayed'));
    }

    const body = await this.post<{
      accessToken?: string;
      expiryTime?: string;
      dhanClientId?: string;
      dhanClientName?: string;
    }>(`/app/consumeApp-consent?tokenId=${encodeURIComponent(input.tokenId)}`);

    if (!body.accessToken) {
      securityLog({
        event: 'broker.oauth.exchange_failed',
        outcome: 'failure',
        userId: stateRow.userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { provider: PROVIDER, reason: 'no_access_token' },
      });
      throw new BadGatewayException('Dhan did not return an accessToken');
    }

    // Dhan reports its own expiry; trust it rather than assuming 24h from now,
    // so the status view and any refresh logic agree with the broker.
    const expiresAt = body.expiryTime ? new Date(body.expiryTime) : null;
    const data = {
      accessToken: body.accessToken,
      brokerClientId: body.dhanClientId ?? null,
      brokerClientName: body.dhanClientName ?? null,
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
      source: 'consent',
    };

    // Scoped to (provider, userId) — the owner comes from the state row, so this
    // upsert can only ever touch the initiating user's own credential.
    await this.prisma.brokerCredential.upsert({
      where: { provider_userId: { provider: PROVIDER, userId: stateRow.userId } },
      update: data,
      create: { provider: PROVIDER, userId: stateRow.userId, ...data },
    });

    securityLog({
      event: 'broker.oauth.credential_stored',
      outcome: 'success',
      userId: stateRow.userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: {
        provider: PROVIDER,
        // Broker-side account id, not a secret — needed to tell which account
        // was linked. The access token is never passed to the logger.
        brokerClientId: data.brokerClientId,
        expiresAt: data.expiresAt?.toISOString() ?? null,
        matchedBy: resolution.matchedBy,
      },
    });

    return { status: await this.status(stateRow.userId), userId: stateRow.userId };
  }

  /**
   * Current credential state for ONE user. Never returns the token itself.
   *
   * SECURITY: takes `userId` and filters on it. The previous signature took no
   * arguments and returned the global row, which disclosed the operator's broker
   * client id and name to every authenticated caller.
   */
  async status(userId: string): Promise<DhanCredentialStatus> {
    const row = await this.prisma.brokerCredential.findUnique({
      where: { provider_userId: { provider: PROVIDER, userId } },
    });
    if (!row) return { ...DISCONNECTED };
    return {
      connected: true,
      brokerClientId: row.brokerClientId,
      brokerClientName: row.brokerClientName,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: row.expiresAt ? row.expiresAt.getTime() <= Date.now() : false,
      source: row.source,
      isFeedDefault: row.isFeedDefault,
    };
  }

  /**
   * Revoke the caller's own stored credential.
   *
   * `deleteMany` on (provider, userId) rather than `delete` by id: a caller
   * cannot name a row, so there is no id to get wrong, and a no-op delete
   * reports "not connected" instead of leaking whether some other row exists.
   */
  async disconnect(userId: string, meta: RequestMeta = {}): Promise<{ disconnected: boolean }> {
    const result = await this.prisma.brokerCredential.deleteMany({
      where: { provider: PROVIDER, userId },
    });
    securityLog({
      event: 'broker.credential.disconnected',
      outcome: 'success',
      userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: { provider: PROVIDER, removed: result.count },
    });
    return { disconnected: result.count > 0 };
  }

  /**
   * Designate which user's credential the shared live-feed bridge runs on.
   *
   * OPERATOR ACTION — the controller gates this with `AdminTokenGuard`, not
   * `AuthGuard`. It has to be: promoting a credential to feed-default makes it
   * the token every anonymous market-data consumer is served from, so a user
   * must not be able to volunteer their own (or elect someone else's).
   *
   * Replaces the old implicit rule "the feed uses the only row in the table",
   * which under per-user credentials would silently mean "whichever row the
   * query returned first".
   */
  async setFeedDefault(userId: string, meta: RequestMeta = {}): Promise<DhanCredentialStatus> {
    const existing = await this.prisma.brokerCredential.findUnique({
      where: { provider_userId: { provider: PROVIDER, userId } },
    });
    if (!existing) {
      securityLog({
        event: 'broker.feed_default.denied',
        outcome: 'denied',
        userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { provider: PROVIDER, reason: 'no_credential' },
      });
      throw new NotFoundException('That user has no stored Dhan credential to promote.');
    }
    if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
      // Promoting a dead token would take the feed down at the next reconnect
      // and read as a bridge fault rather than an expired credential.
      throw new BadRequestException('That credential has expired. Re-run consent before promoting it.');
    }

    // Clear-then-set in one transaction. The partial unique index
    // (isFeedDefault = true) would reject two defaults anyway; the transaction
    // is what stops the clear from committing without the set.
    await this.prisma.$transaction([
      this.prisma.brokerCredential.updateMany({
        where: { provider: PROVIDER, isFeedDefault: true },
        data: { isFeedDefault: false },
      }),
      this.prisma.brokerCredential.update({
        where: { id: existing.id },
        data: { isFeedDefault: true },
      }),
    ]);

    securityLog({
      event: 'broker.feed_default.set',
      outcome: 'success',
      userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: { provider: PROVIDER, brokerClientId: existing.brokerClientId },
    });
    return this.status(userId);
  }

  /** Operator view: who has linked a broker, without any token material. */
  async listCredentials(): Promise<
    Array<{ userId: string; brokerClientId: string | null; expiresAt: string | null; expired: boolean; isFeedDefault: boolean; source: string }>
  > {
    const rows = await this.prisma.brokerCredential.findMany({
      where: { provider: PROVIDER },
      orderBy: { updatedAt: 'desc' },
      // Explicit select rather than a full row: `accessToken` must not be able
      // to reach a response body by someone later spreading the object.
      select: {
        userId: true,
        brokerClientId: true,
        expiresAt: true,
        isFeedDefault: true,
        source: true,
      },
    });
    return rows.map((r) => ({
      userId: r.userId,
      brokerClientId: r.brokerClientId,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: r.expiresAt ? r.expiresAt.getTime() <= Date.now() : false,
      isFeedDefault: r.isFeedDefault,
      source: r.source,
    }));
  }

  /**
   * The live token, for the feed bridge.
   *
   * The ONE method here that is not user-scoped, deliberately: the bridge is a
   * single shared process with no user context. It reads only the credential
   * explicitly designated `isFeedDefault` — never "the first row for this
   * provider" — so an ordinary user linking their own broker account cannot end
   * up powering the shared feed as a side effect.
   *
   * Falls back to DHAN_ACCESS_TOKEN so a machine that never ran the consent flow
   * keeps working exactly as before. An expired stored token is skipped in
   * favour of the env value rather than handed out to fail on first use.
   *
   * NOT exposed over HTTP by any route. It is called in-process only.
   */
  async currentAccessToken(): Promise<{ accessToken: string; source: string } | null> {
    const row = await this.prisma.brokerCredential.findFirst({
      where: { provider: PROVIDER, isFeedDefault: true },
    });
    const fresh = row && (!row.expiresAt || row.expiresAt.getTime() > Date.now());
    if (fresh && row) return { accessToken: row.accessToken, source: row.source };
    const fromEnv = process.env.DHAN_ACCESS_TOKEN;
    if (fromEnv) return { accessToken: fromEnv, source: 'env' };
    return null;
  }

  /** Delete states that are past expiry. They are already refused on merit —
   *  this is hygiene, and it keeps the sole-pending-flow fallback accurate. */
  private async sweepExpiredStates(): Promise<void> {
    await this.prisma.brokerOAuthState
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - STATE_TTL_MS) } } })
      .catch(() => undefined);
  }

  private logStateRejection(
    reason: StateRejection,
    meta: RequestMeta,
    candidateState?: string | null,
    userId?: string | null,
  ): void {
    securityLog({
      event: 'broker.oauth.state_rejected',
      outcome: 'denied',
      userId: userId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      // `statePresent` rather than the state value: whether one was supplied is
      // the useful signal, and the value is a live bearer secret.
      detail: { provider: PROVIDER, reason, statePresent: Boolean(candidateState) },
    });
  }
}

/** Thrown when a caller tries to act on another user's credential. Kept here so
 *  the controller and any future broker service raise the identical shape. */
export function denyCrossUserAccess(actingUserId: string, targetUserId: string, meta: RequestMeta = {}): never {
  securityLog({
    event: 'broker.credential.cross_user_denied',
    outcome: 'denied',
    userId: actingUserId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: { provider: PROVIDER, targetUserId },
  });
  throw new ForbiddenException('You may only manage your own broker connection.');
}
