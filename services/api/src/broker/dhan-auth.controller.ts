import { Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AdminTokenGuard } from '../auth/admin-token.guard';
import { securityLog } from '../common/security-log';
import { clearSecureCookie, readCookie, serializeSecureCookie } from '../common/secure-cookie';
import { STATE_TTL_MS } from './oauth-state';
import { DhanAuthService, denyCrossUserAccess } from './dhan-auth.service';

/**
 * Only the members actually used are declared, so this stays structural rather
 * than pulling @types/express into the API for two imports.
 */
interface RedirectingResponse {
  redirect(url: string): void;
  setHeader(name: string, value: string): void;
}
interface AuthedRequest {
  user?: { sub?: string; email?: string };
  ip?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** Second binding factor for the OAuth flow — see the `callback` docstring. */
const STATE_COOKIE = 'tradew_broker_state';

/**
 * Scoped to `/`, not to `/broker/dhan`, and the reason is not cosmetic.
 *
 * This API is reached through the web origin's proxy: production builds with
 * `NEXT_PUBLIC_API_URL=/api` (.github/workflows/deploy.yml), so `/connect` is
 * requested at `/api/broker/dhan/connect` and the broker's redirect lands at
 * `/api/broker/dhan/callback`. A cookie scoped `Path=/broker/dhan` does not match
 * either path, so it would be set and then never sent — a binding factor that
 * silently never engages, which is worse than not having one, because the code
 * reads as though a check is happening.
 *
 * `/` is safe here: the value is HttpOnly, opaque, expires in 10 minutes, and is
 * not a credential for anything — it only has to agree with the `state` query
 * parameter. It is cleared on every callback outcome.
 *
 * Known limit, stated rather than implied: when the app addresses the API
 * cross-origin instead of through the proxy (the dev default,
 * `http://localhost:4000`), `api()` issues the fetch without
 * `credentials: 'include'`, so the browser discards this cookie and the check
 * does not apply. The server-side state row is authoritative in every
 * configuration; this cookie only ever adds a second factor when connect and
 * callback share an origin.
 */
const COOKIE_PATH = '/';

/**
 * Dhan broker connection.
 *
 * ── AUTHORIZATION MAP ──────────────────────────────────────────────────────
 *
 *   GET    /broker/dhan/connect          AuthGuard        acts as the caller
 *   GET    /broker/dhan/status            AuthGuard        caller's own row only
 *   DELETE /broker/dhan/credential        AuthGuard        caller's own row only
 *   GET    /broker/dhan/callback          PUBLIC + state   see below
 *   GET    /broker/dhan/admin/credentials AdminTokenGuard  operator
 *   POST   /broker/dhan/admin/feed-default/:userId
 *                                         AdminTokenGuard  operator
 *
 * Every authenticated route derives its subject from `req.user.sub` and never
 * from a path or query parameter. Where a caller CAN name a user (the operator
 * routes, and the optional `?userId=` echo on /status), the value is checked
 * against the token and a mismatch is refused and logged — it is never used as
 * the lookup key.
 *
 * ── WHY /callback IS PUBLIC ────────────────────────────────────────────────
 *
 * It is the URL registered with Dhan, and the request arrives as a top-level
 * browser navigation from auth.dhan.co. Cross-site navigations carry no
 * Authorization header, so requiring `AuthGuard` here would break the flow
 * rather than secure it — this is the "wherever compatible with the OAuth flow"
 * boundary.
 *
 * What replaces bearer auth is a server-side state record: the callback is only
 * honoured when it matches a live, unconsumed, unexpired flow that an
 * AUTHENTICATED user started, and the credential is written to that user. The
 * previous version had no such record, which is what made the endpoint
 * exploitable: it accepted any well-formed callback and wrote to a single global
 * credential row. See `oauth-state.ts` for the threat model and
 * `dhan-auth.service.ts` for the single-use enforcement.
 */
@Controller('broker/dhan')
export class DhanAuthController {
  constructor(private readonly dhan: DhanAuthService) {}

  /**
   * Begin the flow. Returns the Dhan login URL the user must open — the browser
   * step needs the account's own 2FA and cannot be automated.
   *
   * Sets the state cookie as a second, independent binding factor. The cookie is
   * defence in depth, not the primary control: the server-side state row is
   * authoritative, and the callback still works if the cookie is absent (a
   * different browser, a stripped cookie, a curl-driven flow). When it IS
   * present it must match, which closes the case where an attacker knows or
   * guesses a state value but cannot write cookies for this origin.
   */
  @UseGuards(AuthGuard)
  @Get('connect')
  async connect(@Req() req: AuthedRequest, @Res() res: RedirectingResponse) {
    const userId = subjectOf(req);
    const meta = metaOf(req);
    const started = await this.dhan.startConsent(userId, meta);

    res.setHeader(
      'Set-Cookie',
      serializeSecureCookie({
        name: STATE_COOKIE,
        value: started.state,
        maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000),
        path: COOKIE_PATH,
      }),
    );

    // `state` is returned so a caller driving this programmatically (or a
    // provider that echoes it) can present it on the callback. It is a
    // single-use, 10-minute value scoped to this user's flow.
    return jsonOf(res, {
      consentAppId: started.consentAppId,
      loginUrl: started.loginUrl,
      state: started.state,
      expiresInMs: started.expiresInMs,
    });
  }

  /**
   * Connection state for the CALLER. Never includes the access token.
   *
   * `?userId=` is accepted only so a client that tracks the id can assert it
   * matches; a value that differs from the token's subject is refused rather
   * than honoured. Previously this route took no subject at all and returned the
   * single global credential, disclosing the operator's broker client id and
   * name to every authenticated user.
   */
  @UseGuards(AuthGuard)
  @Get('status')
  status(@Req() req: AuthedRequest, @Query('userId') userId?: string) {
    const subject = subjectOf(req);
    if (userId && userId !== subject) denyCrossUserAccess(subject, userId, metaOf(req));
    return this.dhan.status(subject);
  }

  /** Revoke the caller's own stored credential. Scoped to the token's subject —
   *  there is no route that deletes another user's credential. */
  @UseGuards(AuthGuard)
  @Delete('credential')
  disconnect(@Req() req: AuthedRequest) {
    return this.dhan.disconnect(subjectOf(req), metaOf(req));
  }

  /**
   * Dhan's redirect lands here with `?tokenId=` (and `?state=` when the provider
   * preserves it). Validates the flow, exchanges the token, stores it against
   * the user who started the flow, then bounces the browser to a readable page
   * rather than leaving them looking at raw JSON.
   *
   * Failures redirect with a stable, non-revealing `reason`. They do not leak
   * whether a state existed, whose it was, or what the correct value would be.
   */
  @Get('callback')
  async callback(
    @Query('tokenId') tokenId: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: AuthedRequest,
    @Res() res: RedirectingResponse,
  ) {
    const appBase = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
    const meta = metaOf(req);

    // The cookie is cleared on every outcome. A binding value that survives its
    // flow is a credential with no expiry, and leaving it set would let a later
    // callback in the same browser inherit it.
    res.setHeader('Set-Cookie', clearSecureCookie(STATE_COOKIE, COOKIE_PATH));

    if (!tokenId) {
      securityLog({
        event: 'broker.oauth.callback_rejected',
        outcome: 'denied',
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { provider: 'dhan', reason: 'missing_token', statePresent: Boolean(state) },
      });
      return res.redirect(`${appBase}/settings?dhan=error&reason=missing_token`);
    }

    // Defence in depth: when the browser presents a state cookie, it must agree
    // with the query parameter. Absent cookie is allowed (see `connect`);
    // a CONFLICTING one is refused, because that is the shape of a state value
    // being replayed from somewhere other than the browser that started the flow.
    const cookieState = readCookie(cookieHeaderOf(req), STATE_COOKIE);
    if (cookieState && state && cookieState !== state) {
      securityLog({
        event: 'broker.oauth.callback_rejected',
        outcome: 'denied',
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { provider: 'dhan', reason: 'state_cookie_mismatch' },
      });
      return res.redirect(`${appBase}/settings?dhan=error&reason=state_cookie_mismatch`);
    }

    try {
      // The state (query param, else cookie) selects the flow. Nothing in this
      // request decides WHOSE credential is written — the state row does.
      const { status } = await this.dhan.consumeConsent({
        tokenId,
        candidateState: state ?? cookieState,
        meta,
      });
      return res.redirect(
        `${appBase}/settings?dhan=connected&client=${encodeURIComponent(status.brokerClientId ?? '')}`,
      );
    } catch (err) {
      // Message, not stack, and it is already written to be non-revealing by
      // `rejectionMessage`. Anything unexpected collapses to a generic reason.
      const reason = err instanceof Error && err.message ? err.message : 'exchange_failed';
      return res.redirect(`${appBase}/settings?dhan=error&reason=${encodeURIComponent(reason)}`);
    }
  }

  // ------------------------------------------------------------- operator only

  /**
   * Who has linked a broker account. Token material is excluded at the query
   * level, not filtered afterwards.
   *
   * `AdminTokenGuard`, not `AuthGuard`: this is a cross-user view, so ownership
   * cannot authorize it and there is no per-user reading of it that makes sense.
   */
  @UseGuards(AdminTokenGuard)
  @Get('admin/credentials')
  listCredentials() {
    return this.dhan.listCredentials();
  }

  /**
   * Designate which user's credential the shared live-feed bridge runs on.
   *
   * Operator-gated because it is the one broker action with platform-wide
   * effect: the promoted token serves every market-data consumer. A user must
   * not be able to elect their own credential (or anyone else's) into that role,
   * which is why this is the only route here that legitimately names another
   * user — and why it is not reachable with a user bearer token at all.
   */
  @UseGuards(AdminTokenGuard)
  @Post('admin/feed-default/:userId')
  setFeedDefault(@Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.dhan.setFeedDefault(userId, metaOf(req));
  }
}

/** The authenticated subject. `AuthGuard` has already verified the JWT, so a
 *  missing `sub` means a malformed token rather than an anonymous caller — it is
 *  treated as a hard failure rather than defaulting to anything. */
function subjectOf(req: AuthedRequest): string {
  const sub = req.user?.sub;
  if (!sub || typeof sub !== 'string') {
    securityLog({
      event: 'broker.auth.missing_subject',
      outcome: 'denied',
      ip: req.ip ?? null,
      detail: { path: req.url },
    });
    throw new Error('Authenticated request carried no subject');
  }
  return sub;
}

function metaOf(req: AuthedRequest): { ip: string | null; userAgent: string | null } {
  const ua = req.headers?.['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null };
}

function cookieHeaderOf(req: AuthedRequest): string | null {
  const raw = req.headers?.cookie;
  return typeof raw === 'string' ? raw : null;
}

/** `@Res()` opts out of Nest's automatic serialization, so the JSON routes that
 *  also need to set a header have to write the body themselves. */
function jsonOf(res: RedirectingResponse, body: unknown) {
  const withJson = res as unknown as { json?: (b: unknown) => void; end?: (b?: string) => void };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (typeof withJson.json === 'function') return withJson.json(body);
  return withJson.end?.(JSON.stringify(body));
}
