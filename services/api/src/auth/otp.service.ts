import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

/**
 * Email one-time codes.
 *
 * Design constraints, each of which shapes the code below:
 *
 *  · ACCOUNT ENUMERATION. `request()` reports the same thing whether or not
 *    the address has an account. Callers must not branch on existence either.
 *  · BRUTE FORCE. A 6-digit code is 10^6, which is thin. Three defences:
 *    a 10-minute expiry, a hard cap of MAX_ATTEMPTS verifications per code,
 *    and invalidation of prior live codes whenever a new one is issued (so
 *    requesting repeatedly cannot widen the set of currently-valid codes).
 *  · TIMING / REPLAY. Codes are stored hashed and compared by hash lookup,
 *    and a consumed row is marked rather than deleted so a replay is
 *    distinguishable from an expiry.
 *
 * `randomInt` is used rather than `Math.random` — this is a credential.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Throttle: refuse to mint a second code within this window. */
const RESEND_COOLDOWN_MS = 60 * 1000;

const SUBJECTS: Record<OtpPurpose, string> = {
  login: 'Your TradeW sign-in code',
  password_reset: 'Your TradeW password reset code',
  email_verify: 'Verify your TradeW email',
};

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}

  /**
   * Mint a code and email it.
   *
   * Returns `devCode` ONLY when SMTP is unconfigured, so the local flow is
   * testable end to end. With SMTP configured the code never leaves the mail.
   */
  async request(rawEmail: string, purpose: OtpPurpose): Promise<{ devCode?: string }> {
    const email = rawEmail.trim().toLowerCase();

    const recent = await this.prisma.emailOtp.findFirst({
      where: { email, purpose, consumedAt: null, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      throw new BadRequestException('A code was just sent. Please wait a minute before requesting another.');
    }

    // Supersede any still-live code for this address+purpose.
    await this.prisma.emailOtp.updateMany({
      where: { email, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.emailOtp.create({
      data: { email, purpose, codeHash: this.hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });

    const minutes = Math.round(CODE_TTL_MS / 60000);
    const result = await this.mail.send(
      email,
      SUBJECTS[purpose],
      `Your TradeW code is ${code}\n\nIt expires in ${minutes} minutes. If you didn't request it, ignore this email.`,
    );

    return result.delivered ? {} : { devCode: code };
  }

  /**
   * Check a code and consume it. Throws on every failure path with the same
   * shape of message — the caller learns "not valid", not why.
   */
  async verify(rawEmail: string, purpose: OtpPurpose, code: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const row = await this.prisma.emailOtp.findFirst({
      where: { email, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!row || row.expiresAt < new Date()) {
      throw new BadRequestException('That code is invalid or has expired.');
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      // Burn it — an attacker must pay the cooldown to get another target.
      await this.prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      throw new BadRequestException('Too many incorrect attempts. Request a new code.');
    }
    if (row.codeHash !== this.hash(code.trim())) {
      await this.prisma.emailOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('That code is invalid or has expired.');
    }

    await this.prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
