import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './otp.service';

type RequestMeta = { ip?: string; userAgent?: string };

@Injectable()
export class AuthService {
  private readonly refreshDays = Number(process.env.REFRESH_TOKEN_DAYS || 30);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otp: OtpService,
  ) {}

  /**
   * Password reset — step 1: email a one-time code.
   *
   * Account enumeration is the whole risk here, so the response is IDENTICAL
   * whether or not the address has an account: a code is only actually minted
   * and sent when the user exists, but the caller can never tell the
   * difference from the return value. `devCode` is surfaced only in dev (SMTP
   * unconfigured), and only when a user genuinely exists, so it cannot be used
   * to probe for accounts on a properly-configured deployment.
   */
  async requestPasswordReset(email: string, meta: RequestMeta = {}): Promise<{ ok: true; devCode?: string }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      // Deliberately do nothing observable — same shape, no email sent.
      return { ok: true };
    }
    const { devCode } = await this.otp.request(normalized, 'password_reset');
    await this.audit('user.password_reset.requested', user.id, meta);
    return devCode ? { ok: true, devCode } : { ok: true };
  }

  /**
   * Password reset — step 2: verify the code and set the new password.
   *
   * On success EVERY existing session is revoked: a reset is exactly the
   * action you take when you fear the account is compromised, so leaving old
   * refresh tokens alive would defeat it.
   */
  async resetPassword(email: string, code: string, newPassword: string, meta: RequestMeta = {}): Promise<{ ok: true }> {
    const normalized = email.trim().toLowerCase();
    // Throws BadRequest on a wrong/expired/exhausted code — same generic
    // message the OTP service uses, so nothing leaks here either.
    await this.otp.verify(normalized, 'password_reset', code);

    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user) throw new BadRequestException('That code is invalid or has expired.');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit('user.password_reset.success', user.id, meta);
    return { ok: true };
  }

  async signup(email: string, password: string, meta: RequestMeta = {}) {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new BadRequestException('Email already registered');
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({ data: { email: normalizedEmail, passwordHash } });
    await this.audit('user.signup.success', user.id, meta);
    return this.issue(user.id, user.email);
  }

  async login(email: string, password: string, meta: RequestMeta = {}) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) {
      await this.audit('user.login.failure', null, meta, { email: email.trim().toLowerCase() });
      throw new UnauthorizedException('Invalid credentials');
    }
    // A Google-only or phone-only account has no password credential. Reject
    // before bcrypt: `compare(password, null)` is not a meaningful question,
    // and the answer must be indistinguishable from a wrong password so this
    // cannot be used to discover which accounts are Google-linked.
    if (!user.passwordHash) {
      await this.audit('user.login.failure', user.id, meta, { reason: 'no_password_credential' });
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      await this.audit('user.login.failure', user.id, meta);
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.audit('user.login.success', user.id, meta);
    return this.issue(user.id, user.email);
  }

  /**
   * Google sign-in. Called with an already-verified profile — this method
   * trusts its input, so the caller (GoogleOauthService) is responsible for
   * having validated the token with Google first.
   *
   * Three cases, in order:
   *  1. Known googleId       → sign in.
   *  2. Known email, no link → LINK the Google identity to the existing
   *     account rather than failing. Google has verified the address, so the
   *     person controls that mailbox; refusing here would strand anyone who
   *     signed up with a password and later clicked "Continue with Google".
   *  3. Neither              → create the account.
   *
   * Case 2 is why `emailVerified` is required: linking on an unverified
   * address would let anyone who can set a Google profile email to yours take
   * over your TradeW account.
   */
  async loginWithGoogle(
    profile: { googleId: string; email: string; emailVerified: boolean },
    meta: RequestMeta = {},
  ) {
    const email = profile.email.trim().toLowerCase();

    const linked = await this.prisma.user.findUnique({ where: { googleId: profile.googleId } });
    if (linked) {
      await this.audit('user.login.success', linked.id, meta, { method: 'google' });
      return this.issue(linked.id, linked.email);
    }

    if (!profile.emailVerified) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      const updated = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId: profile.googleId },
      });
      await this.audit('user.google.linked', updated.id, meta);
      return this.issue(updated.id, updated.email);
    }

    // New account with no passwordHash — Google is the only credential until
    // the user sets a password.
    const created = await this.prisma.user.create({
      data: { email, googleId: profile.googleId },
    });
    await this.audit('user.signup.success', created.id, meta, { method: 'google' });
    return this.issue(created.id, created.email);
  }

  /**
   * Phone sign-in — step 1: SMS a one-time code.
   *
   * Unlike password reset, this one mints a code for numbers with no account
   * too, because a successful verify CREATES the account (see below). There is
   * therefore nothing to enumerate: every valid number gets the same response
   * whether or not it is already registered.
   */
  async requestPhoneCode(phone: string, meta: RequestMeta = {}): Promise<{ ok: true; devCode?: string }> {
    const normalised = phone.replace(/\s+/g, '');
    const { devCode } = await this.otp.request(normalised, OtpPurpose.phone_verify);
    await this.audit('user.phone.code_requested', null, meta, { phone: normalised });
    return devCode ? { ok: true, devCode } : { ok: true };
  }

  /**
   * Phone sign-in — step 2: verify the code, then sign in or register.
   *
   * A verified phone number is treated as sufficient to create an account, so
   * this doubles as signup. The synthesised email is a placeholder the user
   * can change later; it is marked with a reserved domain so it is obvious in
   * the database that nobody ever typed it.
   */
  async verifyPhoneCode(phone: string, code: string, meta: RequestMeta = {}) {
    const normalised = phone.replace(/\s+/g, '');
    await this.otp.verify(normalised, OtpPurpose.phone_verify, code);

    const existing = await this.prisma.user.findUnique({ where: { phone: normalised } });
    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { phoneVerifiedAt: new Date() },
      });
      await this.audit('user.login.success', existing.id, meta, { method: 'phone' });
      return this.issue(existing.id, existing.email);
    }

    const created = await this.prisma.user.create({
      data: {
        email: `${normalised.replace(/\D/g, '')}@phone.tradew.local`,
        phone: normalised,
        phoneVerifiedAt: new Date(),
      },
    });
    await this.audit('user.signup.success', created.id, meta, { method: 'phone' });
    return this.issue(created.id, created.email);
  }

  async refresh(refreshToken: string, meta: RequestMeta = {}) {
    const tokenHash = this.hash(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      await this.audit('session.refresh.failure', row?.userId || null, meta);
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    await this.audit('session.refresh.success', row.userId, meta);
    return this.issue(row.user.id, row.user.email);
  }

  async logout(userId: string, refreshToken?: string, meta: RequestMeta = {}) {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash: this.hash(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit('session.logout', userId, meta);
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, country: true, experienceLevel: true, optionsFamiliarity: true, createdAt: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  async updateMe(userId: string, data: { country?: string; experienceLevel?: string | null; optionsFamiliarity?: string | null }, meta: RequestMeta = {}) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        country: data.country || undefined,
        experienceLevel: data.experienceLevel,
        optionsFamiliarity: data.optionsFamiliarity,
      },
      select: { id: true, email: true, country: true, experienceLevel: true, optionsFamiliarity: true, createdAt: true },
    });
    await this.audit('user.profile.update', userId, meta, { fields: Object.keys(data) });
    return user;
  }

  async listPreferences(userId: string) {
    const rows = await this.prisma.userPreference.findMany({ where: { userId }, orderBy: { key: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setPreference(userId: string, key: string, value: unknown, meta: RequestMeta = {}) {
    const pref = await this.prisma.userPreference.upsert({
      where: { userId_key: { userId, key } },
      update: { value: value as any },
      create: { userId, key, value: value as any },
    });
    await this.audit('user.preference.update', userId, meta, { key });
    return { key: pref.key, value: pref.value };
  }

  private async issue(userId: string, email: string) {
    const accessToken = this.jwt.sign({ sub: userId, email }, { expiresIn: process.env.ACCESS_TOKEN_TTL || '15m' });
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshDays * 24 * 60 * 60 * 1000);
    await this.prisma.refreshToken.create({ data: { userId, tokenHash: this.hash(refreshToken), expiresAt } });
    return { accessToken, refreshToken, user: { id: userId, email } };
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async audit(eventType: string, userId: string | null, meta: RequestMeta = {}, metadata?: Record<string, unknown>) {
    await this.prisma.auditEvent.create({
      data: { eventType, userId: userId || undefined, ip: meta.ip, userAgent: meta.userAgent, metadata: metadata as any },
    }).catch(() => undefined);
  }
}
