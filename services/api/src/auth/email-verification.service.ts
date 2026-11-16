import { BadRequestException, GoneException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../mail/email.service';

/** Link lifetime. Long enough to survive "I'll check my email tonight". */
export const VERIFY_TOKEN_TTL_HOURS = 24;
/** Resend cooldown, per address. The route is also throttled per IP. */
const RESEND_COOLDOWN_MS = 60 * 1000;

export type VerifyOutcome = 'verified' | 'already_verified';

/**
 * Email verification by single-use link.
 *
 * Reuses the `Otp` table (purpose `email_verify`) rather than adding a token
 * table: it already gives hashed storage, expiry, consumption and
 * supersede-on-reissue, which are exactly the properties a verification token
 * needs. The difference from a 6-digit code is the secret: 32 random bytes,
 * base64url, so brute force is not a concern and no attempt counter is needed.
 *
 * Only the SHA-256 of the token is stored, so a database read never yields a
 * working link.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private verifyUrl(token: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/verify-email?token=${encodeURIComponent(token)}`;
  }

  /**
   * Mint a new token (superseding any live one) and email the link.
   * `template` distinguishes the first email from a resend; both carry a link.
   */
  async issue(
    user: { id: string; email: string; firstName?: string | null },
    template: 'verify_email' | 'resend_verification' = 'verify_email',
  ): Promise<{ devVerifyUrl?: string }> {
    const destination = user.email.trim().toLowerCase();
    await this.prisma.otp.updateMany({
      where: { destination, purpose: OtpPurpose.email_verify, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const token = randomBytes(32).toString('base64url');
    await this.prisma.otp.create({
      data: {
        destination,
        purpose: OtpPurpose.email_verify,
        codeHash: this.hash(token),
        expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3600_000),
      },
    });
    const url = this.verifyUrl(token);
    const result = await this.email.sendTemplate(
      template,
      destination,
      { FirstName: user.firstName || 'there', Email: destination, VerifyUrl: url, ExpiresInHours: String(VERIFY_TOKEN_TTL_HOURS) },
      { userId: user.id },
    );
    // Same disclosure rule as OtpService: only in console mode (no provider,
    // so the link never left this process) is it returned to the caller.
    return result.preview !== undefined ? { devVerifyUrl: url } : {};
  }

  /**
   * Resend, enumeration-safe: the response is the same whether the address is
   * unknown, already verified, or pending. Only the pending case sends mail.
   */
  async resend(rawEmail: string): Promise<{ ok: true; devVerifyUrl?: string }> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, firstName: true, emailVerifiedAt: true },
    });
    if (!user || user.emailVerifiedAt || !EmailService.isDeliverable(user.email)) return { ok: true };

    const recent = await this.prisma.otp.findFirst({
      where: { destination: email, purpose: OtpPurpose.email_verify, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    });
    if (recent) {
      throw new BadRequestException('A link was just sent. Please wait a minute before asking for another.');
    }
    const { devVerifyUrl } = await this.issue(user, 'resend_verification');
    return devVerifyUrl ? { ok: true, devVerifyUrl } : { ok: true };
  }

  /**
   * Redeem a token. Outcomes:
   *  · valid → the address is marked verified, the token consumed → 'verified'
   *  · consumed, and its owner is verified → 'already_verified' (a double
   *    click or a re-opened email must not look like an error)
   *  · expired → 410 Gone, so the UI can offer a resend
   *  · unknown or superseded → 400
   */
  async verify(token: string): Promise<{ outcome: VerifyOutcome; userId: string; email: string; firstName: string | null }> {
    const trimmed = (token || '').trim();
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(trimmed)) {
      throw new BadRequestException('This verification link is not valid.');
    }
    const row = await this.prisma.otp.findFirst({
      where: { codeHash: this.hash(trimmed), purpose: OtpPurpose.email_verify },
    });
    if (!row) throw new BadRequestException('This verification link is not valid.');

    const user = await this.prisma.user.findUnique({
      where: { email: row.destination },
      select: { id: true, email: true, firstName: true, emailVerifiedAt: true },
    });
    if (!user) throw new BadRequestException('This verification link is not valid.');

    if (row.consumedAt) {
      if (user.emailVerifiedAt) return { outcome: 'already_verified', userId: user.id, email: user.email, firstName: user.firstName };
      throw new BadRequestException('This verification link has been replaced by a newer one. Use the latest email, or ask for a new link.');
    }
    if (row.expiresAt < new Date()) {
      throw new GoneException('This verification link has expired. Ask for a new one.');
    }

    // Consume first, conditionally: of two concurrent clicks exactly one flips
    // consumedAt, and only that one proceeds to send the welcome email.
    const consumed = await this.prisma.otp.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count === 0) {
      return { outcome: 'already_verified', userId: user.id, email: user.email, firstName: user.firstName };
    }
    if (user.emailVerifiedAt) return { outcome: 'already_verified', userId: user.id, email: user.email, firstName: user.firstName };

    await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return { outcome: 'verified', userId: user.id, email: user.email, firstName: user.firstName };
  }
}
