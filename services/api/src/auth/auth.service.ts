import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
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
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      await this.audit('user.login.failure', user.id, meta);
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.audit('user.login.success', user.id, meta);
    return this.issue(user.id, user.email);
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
