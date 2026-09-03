import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsObject, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AUTH_LIMIT, OTP_LIMIT } from '../common/throttling';
import { SECURITY } from '../swagger/swagger.setup';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_STATE_TTL_SECONDS,
  GoogleOauthService,
} from './google-oauth.service';
import { clearSecureCookie, readCookie, serializeSecureCookie } from '../common/secure-cookie';

class AuthDto {
  @ApiProperty({ format: 'email', example: 'trader@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  password!: string;

  /**
   * The name the user gave their assistant on the landing page, before this
   * account existed (`AI-PERSONA.md` §2). Optional and best-effort: it is
   * re-validated server-side, and a rejected name never fails the signup.
   * Ignored entirely on `login`.
   */
  @ApiProperty({ required: false, maxLength: 24, example: 'Nova' })
  @IsOptional()
  @IsString()
  aiPersonaName?: string;
}

class RefreshDto {
  @ApiProperty({ description: 'The refreshToken from a previous login, signup or refresh. Single use.' })
  @IsString()
  refreshToken!: string;
}

class ForgotPasswordDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;
}

class ResetPasswordDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'The one-time code emailed by POST /auth/password/forgot.' })
  @IsString()
  code!: string;

  @ApiProperty({ minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

class UpdateProfileDto {
  @ApiProperty({ required: false, example: 'IN' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ required: false, example: 'beginner' })
  @IsOptional()
  @IsString()
  experienceLevel?: string;

  @ApiProperty({ required: false, example: 'none' })
  @IsOptional()
  @IsString()
  optionsFamiliarity?: string;
}

class ChangePasswordDto {
  @ApiProperty({ format: 'password', description: 'The password the caller signs in with today.' })
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

class RevokeOtherSessionsDto {
  @ApiProperty({
    required: false,
    description:
      'The refreshToken of the session to KEEP. Omit to revoke every session, including this one.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

class PreferenceDto {
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Arbitrary JSON stored against the preference key in the path.' })
  @IsObject()
  value!: Record<string, unknown>;
}

/** E.164: a leading +, a non-zero country digit, then 7–14 more. Enforced here
 *  rather than in OtpService so a malformed number is a 400 at the edge and
 *  never reaches the SMS provider (which bills per attempt). */
const E164 = /^\+[1-9]\d{7,14}$/;

class PhoneRequestDto {
  @ApiProperty({ description: 'E.164 format.', example: '+919876543210' })
  @IsString()
  @Matches(E164, { message: 'phone must be in E.164 format, e.g. +919876543210' })
  phone!: string;
}

class PhoneVerifyDto {
  @ApiProperty({ description: 'E.164 format.', example: '+919876543210' })
  @IsString()
  @Matches(E164, { message: 'phone must be in E.164 format, e.g. +919876543210' })
  phone!: string;

  @ApiProperty({ description: 'The 6-digit code sent by SMS.', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

function meta(req: any) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleOauthService,
  ) {}

  /**
   * Which sign-in methods this deployment can actually offer.
   *
   * The landing page calls this on mount so the Social tab can say "not
   * available on this server" instead of rendering a button that 503s. Public
   * and deliberately uninformative beyond booleans — it reveals configuration,
   * not credentials.
   */
  @Get('methods')
  methods() {
    return {
      password: true,
      google: this.google.configured,
      phone: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    };
  }

  /** Begin Google sign-in. Redirects the browser to Google's consent screen. */
  @Get('google')
  startGoogle(@Res() res: any) {
    const { url, rawState } = this.google.start();
    // The raw state rides in an HttpOnly cookie; only its hash goes to Google.
    // Scoped to /auth so it is not attached to every request to this origin.
    res.setHeader(
      'Set-Cookie',
      serializeSecureCookie({
        name: GOOGLE_STATE_COOKIE,
        value: rawState,
        maxAgeSeconds: GOOGLE_STATE_TTL_SECONDS,
        path: '/auth',
      }),
    );
    return res.redirect(url);
  }

  /**
   * Google's callback. Arrives as a top-level browser navigation, so it cannot
   * carry a bearer token and cannot return JSON the SPA would read — it hands
   * the token pair to the frontend through the URL fragment, which (unlike a
   * query string) is never sent to a server or written to access logs.
   */
  @Get('google/callback')
  async googleCallback(
    @Req() req: any,
    @Res() res: any,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const frontend = this.google.frontendUrl;
    // Always clear the binding cookie, on every exit path — a state that
    // survives its flow is a credential with no expiry.
    res.setHeader('Set-Cookie', clearSecureCookie(GOOGLE_STATE_COOKIE, '/auth'));

    const fail = (reason: string) =>
      res.redirect(`${frontend}/?auth_error=${encodeURIComponent(reason)}#auth`);

    // The user pressed Cancel on the consent screen, or Google refused.
    if (error) return fail('Google sign-in was cancelled.');
    if (!code) return fail('Google sign-in failed.');

    const cookieState = readCookie(req.headers?.cookie, GOOGLE_STATE_COOKIE);
    if (!this.google.stateMatches(cookieState, state)) {
      return fail('Google sign-in could not be verified. Please try again.');
    }

    try {
      const profile = await this.google.exchange(code);
      const tokens = await this.auth.loginWithGoogle(profile, meta(req));
      const fragment = new URLSearchParams({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
      return res.redirect(`${frontend}/auth/callback#${fragment.toString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed.';
      return fail(message);
    }
  }

  /** Phone sign-in step 1 — SMS a one-time code. */
  // Sends an SMS on every call — metered hardest of anything here.
  @Throttle(OTP_LIMIT)
  @Post('phone/request')
  requestPhoneCode(@Req() req: any, @Body() dto: PhoneRequestDto) {
    return this.auth.requestPhoneCode(dto.phone, meta(req));
  }

  /** Phone sign-in step 2 — verify the code. Signs in, or registers if new. */
  // Verifies a short numeric code: guessable by brute force if unmetered.
  @Throttle(AUTH_LIMIT)
  @Post('phone/verify')
  verifyPhoneCode(@Req() req: any, @Body() dto: PhoneVerifyDto) {
    return this.auth.verifyPhoneCode(dto.phone, dto.code, meta(req));
  }

  /** Create an account. Returns the same `{ accessToken, refreshToken, user }` as login. */
  // Unmetered signup is free unlimited row creation by any anonymous caller.
  @Throttle(AUTH_LIMIT)
  @Post('signup')
  signup(@Req() req: any, @Body() dto: AuthDto) { return this.auth.signup(dto.email, dto.password, meta(req), dto.aiPersonaName); }

  /**
   * Exchange credentials for a token pair.
   *
   * `accessToken` is the bearer token every guarded route on this page wants —
   * paste it into **Authorize**, or use the login bar at the top to do both
   * steps at once. It expires in `ACCESS_TOKEN_TTL` (15 minutes by default).
   */
  // The online password-guessing boundary. bcrypt protects the stored hash;
  // only this protects the endpoint.
  @Throttle(AUTH_LIMIT)
  @Post('login')
  login(@Req() req: any, @Body() dto: AuthDto) { return this.auth.login(dto.email, dto.password, meta(req)); }

  /**
   * Trade a refresh token for a fresh pair once the access token expires.
   *
   * Single use: the presented token is revoked as it is redeemed, so store the
   * new `refreshToken` that comes back.
   */
  @Post('refresh')
  refresh(@Req() req: any, @Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken, meta(req)); }

  /** Password reset step 1 — email a one-time code. Public and enumeration-safe. */
  // Sends mail on every call: unmetered, it is a free spam cannon aimed at
  // arbitrary addresses and at this deployment's sender reputation.
  @Throttle(OTP_LIMIT)
  @Post('password/forgot')
  forgotPassword(@Req() req: any, @Body() dto: ForgotPasswordDto) {
    return this.auth.requestPasswordReset(dto.email, meta(req));
  }

  /** Password reset step 2 — verify the code and set the new password. Public. */
  // A short reset code is only single-use if it cannot be enumerated first.
  @Throttle(AUTH_LIMIT)
  @Post('password/reset')
  resetPassword(@Req() req: any, @Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.email, dto.code, dto.newPassword, meta(req));
  }

  /** Revoke one refresh token, or every one the caller holds when the body is empty. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Post('logout')
  logout(@Req() req: any, @Body() dto: Partial<RefreshDto>) { return this.auth.logout(req.user.sub, dto.refreshToken, meta(req)); }

  /** The signed-in user's profile. Handy for checking a token is live. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Get('me')
  me(@Req() req: any) { return this.auth.me(req.user.sub); }

  /** Update the caller's onboarding profile fields. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Patch('me')
  updateMe(@Req() req: any, @Body() dto: UpdateProfileDto) { return this.auth.updateMe(req.user.sub, dto, meta(req)); }

  /** Every stored preference for the caller. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Get('preferences')
  preferences(@Req() req: any) { return this.auth.listPreferences(req.user.sub); }

  /** Upsert one preference by key. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Post('preferences/:key')
  setPreference(@Req() req: any, @Param('key') key: string, @Body() dto: PreferenceDto) {
    return this.auth.setPreference(req.user.sub, key, dto.value, meta(req));
  }

  /**
   * Change the caller's password from inside a live session.
   *
   * Throttled on the same bucket as login and reset: it takes a password as
   * input and answers whether it was right, so it is a guessing oracle for
   * anyone who has stolen an access token but not the password.
   */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Throttle(AUTH_LIMIT)
  @Post('password/change')
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.sub, dto.currentPassword, dto.newPassword, meta(req));
  }

  /**
   * The caller's live sessions. `?refreshToken=` is optional and only decides
   * which row is flagged `current` — it grants nothing, and the list is always
   * scoped to the token's subject.
   */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Get('sessions')
  sessions(@Req() req: any, @Query('refreshToken') refreshToken?: string) {
    return this.auth.listSessions(req.user.sub, refreshToken);
  }

  /** Sign out everywhere else, keeping the session that presents its own refresh token. */
  @ApiBearerAuth(SECURITY.bearer)
  @UseGuards(AuthGuard)
  @Post('sessions/revoke-others')
  revokeOtherSessions(@Req() req: any, @Body() dto: RevokeOtherSessionsDto) {
    return this.auth.revokeOtherSessions(req.user.sub, dto?.refreshToken, meta(req));
  }
}
