import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';

/**
 * One-time codes, over email or SMS.
 *
 * Design constraints, each of which shapes the code below:
 *
 *  · ACCOUNT ENUMERATION. `request()` reports the same thing whether or not
 *    the destination has an account. Callers must not branch on existence either.
 *  · BRUTE FORCE. A 6-digit code is 10^6, which is thin. Three defences:
 *    a 10-minute expiry, a hard cap of MAX_ATTEMPTS verifications per code,
 *    and invalidation of prior live codes whenever a new one is issued (so
 *    requesting repeatedly cannot widen the set of currently-valid codes).
 *  · TIMING / REPLAY. Codes are stored hashed and compared by hash lookup,
 *    and a consumed row is marked rather than deleted so a replay is
 *    distinguishable from an expiry.
 *
 * The channel is derived from the purpose rather than passed in, so a caller
 * cannot accidentally route a password-reset code to an attacker-supplied
 * phone number. `phone_verify` goes to SMS; everything else goes to mail.
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
  phone_verify: 'Your TradeW sign-in code',
};

/** SMS-delivered purposes. Everything not listed here goes over mail. */
const SMS_PURPOSES: ReadonlySet<OtpPurpose> = new Set<OtpPurpose>([OtpPurpose.phone_verify]);

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
  ) {}

  /**
   * Mint a code and deliver it over the channel the purpose implies.
   *
   * Returns `devCode` ONLY when that channel is unconfigured, so local flows
   * are testable end to end. With SMTP/Twilio configured the code never leaves
   * the message.
   */
  async request(rawDestination: string, purpose: OtpPurpose): Promise<{ devCode?: string }> {
    const destination = this.normalise(rawDestination, purpose);

    const recent = await this.prisma.otp.findFirst({
      where: {
        destination,
        purpose,
        consumedAt: null,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      throw new BadRequestException('A code was just sent. Please wait a minute before requesting another.');
    }

    // Supersede any still-live code for this destination+purpose.
    await this.prisma.otp.updateMany({
      where: { destination, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.otp.create({
      data: { destination, purpose, codeHash: this.hash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });

    const minutes = Math.round(CODE_TTL_MS / 60000);

    if (SMS_PURPOSES.has(purpose)) {
      const result = await this.sms.send(
        destination,
        `Your TradeW code is ${code}. It expires in ${minutes} minutes.`,
      );
      return result.delivered ? {} : { devCode: code };
    }

    const result = await this.mail.send(
      destination,
      SUBJECTS[purpose],
      `Your TradeW code is ${code}\n\nIt expires in ${minutes} minutes. If you didn't request it, ignore this email.`,
    );
    return result.delivered ? {} : { devCode: code };
  }

  /**
   * Check a code and consume it. Throws on every failure path with the same
   * shape of message — the caller learns "not valid", not why.
   */
  async verify(rawDestination: string, purpose: OtpPurpose, code: string): Promise<void> {
    const destination = this.normalise(rawDestination, purpose);
    const row = await this.prisma.otp.findFirst({
      where: { destination, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!row || row.expiresAt < new Date()) {
      throw new BadRequestException('That code is invalid or has expired.');
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      // Burn it — an attacker must pay the cooldown to get another target.
      await this.prisma.otp.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      throw new BadRequestException('Too many incorrect attempts. Request a new code.');
    }
    if (row.codeHash !== this.hash(code.trim())) {
      await this.prisma.otp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('That code is invalid or has expired.');
    }

    await this.prisma.otp.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
  }

  /**
   * Canonicalise before it is ever used as a lookup key, so "  A@B.com " and
   * "a@b.com" cannot hold two independent live codes. Phone numbers only have
   * whitespace stripped — validation that the result is E.164 belongs to the
   * DTO, not here.
   */
  private normalise(raw: string, purpose: OtpPurpose): string {
    return SMS_PURPOSES.has(purpose) ? raw.replace(/\s+/g, '') : raw.trim().toLowerCase();
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
