import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createState, digestsMatch, hashState } from '../broker/oauth-state';

/**
 * Google sign-in (OAuth 2.0 authorization-code flow).
 *
 * WHY NOT `resolvePendingState` FROM THE BROKER FLOW
 *
 * That module is the right shape for connecting a broker: it binds a callback
 * to a state row owned by an ALREADY-AUTHENTICATED user, which is what makes
 * "whose credential is this?" answerable. Login has no such user — the whole
 * point is that nobody is signed in yet — so there is no userId to bind to and
 * no row to own. Reusing it would mean inventing a fake owner.
 *
 * What is reused is the part that genuinely generalises: `createState`,
 * `hashState` and `digestsMatch`. The binding itself is a double-submit cookie
 * — the raw state goes to the browser in an HttpOnly cookie, the hash goes to
 * Google in the `state` parameter, and the callback is only honoured when the
 * two agree. No table, nothing to garbage-collect, and an unsolicited callback
 * carries no cookie so it fails closed.
 *
 * WHY THE PROFILE IS FETCHED FROM `userinfo`
 *
 * The token response also carries an `id_token` whose payload holds the same
 * fields, but reading it means either trusting an unverified JWT or pulling in
 * JWKS verification. One extra server-to-server call on a login is cheaper
 * than either, and leaves nothing to get subtly wrong.
 *
 * WHEN UNCONFIGURED every method throws 503 rather than the module failing to
 * load. The API must boot without Google credentials — most developers will
 * never set them — and the Social tab is expected to report "unavailable"
 * rather than take the whole app down.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Matches the broker flow's window: this is a human completing a consent screen. */
export const GOOGLE_STATE_TTL_SECONDS = 10 * 60;
export const GOOGLE_STATE_COOKIE = 'tw_goauth';

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
}

@Injectable()
export class GoogleOauthService {
  private readonly logger = new Logger(GoogleOauthService.name);
  private readonly clientId = process.env.GOOGLE_CLIENT_ID;
  private readonly clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  constructor() {
    if (!this.configured) {
      this.logger.warn(
        'Google sign-in not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) — /auth/google will return 503',
      );
    }
  }

  /** Where Google sends the browser back. Must match the Authorised redirect
   *  URI registered on the OAuth client exactly, including scheme and port. */
  get redirectUri(): string {
    return (
      process.env.GOOGLE_REDIRECT_URI ||
      `${process.env.API_PUBLIC_URL || 'http://localhost:4000'}/auth/google/callback`
    );
  }

  /** Where the user lands afterwards, success or failure. */
  get frontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured on this server.',
      );
    }
  }

  /**
   * Begin the flow. Returns the URL to redirect to, plus the raw state that
   * must be set as an HttpOnly cookie — the hash of it travels to Google.
   */
  start(): { url: string; rawState: string } {
    this.assertConfigured();
    const { state, stateHash } = createState();

    const params = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: stateHash,
      // Google only returns a verified email claim when we ask for it, and
      // `select_account` stops it silently reusing a session the person may
      // not have intended to sign in with on a shared machine.
      prompt: 'select_account',
    });

    return { url: `${AUTH_ENDPOINT}?${params.toString()}`, rawState: state };
  }

  /** Constant-time check that the callback's `state` matches the cookie. */
  stateMatches(cookieRawState: string | null, callbackState: string | null | undefined): boolean {
    if (!cookieRawState || !callbackState) return false;
    return digestsMatch(hashState(cookieRawState), callbackState);
  }

  /** Exchange the authorization code and read the profile. */
  async exchange(code: string): Promise<GoogleProfile> {
    this.assertConfigured();

    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      this.logger.error(`Google token exchange failed: ${tokenRes.status} ${detail.slice(0, 200)}`);
      throw new UnauthorizedException('Google sign-in failed.');
    }

    const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
    if (!accessToken) throw new UnauthorizedException('Google sign-in failed.');

    const infoRes = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!infoRes.ok) {
      this.logger.error(`Google userinfo failed: ${infoRes.status}`);
      throw new UnauthorizedException('Google sign-in failed.');
    }

    const info = (await infoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
    };

    if (!info.sub || !info.email) {
      throw new UnauthorizedException('Google account did not return an email address.');
    }

    return {
      googleId: info.sub,
      email: info.email,
      // Google omits the claim rather than sending false in some cases, so
      // absence is treated as unverified. AuthService refuses to link an
      // existing account on an unverified address.
      emailVerified: info.email_verified === true,
    };
  }
}
