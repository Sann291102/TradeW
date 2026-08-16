import { describe, expect, it } from 'vitest';
import { OtpPurpose } from '@prisma/client';
import { OtpService } from './otp.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailService, SendResult } from '../mail/mail.service';
import type { SmsService } from '../sms/sms.service';

/**
 * When `POST /auth/otp/request` may put the code in its own response.
 *
 * THE BUG THIS PINS. The rule was "only when the channel is unconfigured", but
 * the test was `!result.delivered` — and both senders return `delivered:false`
 * for two unrelated situations: nothing configured, and a configured provider
 * that refused the message. So on a production server with credentials set, any
 * provider failure (SendGrid 429 at the free-tier cap, Twilio outage, rotated
 * key) made this endpoint return the code to whoever called it. Anyone could
 * request a `login` code for an address they do not own and read it out of the
 * response body — account takeover, on the endpoint whose entire job is to
 * prove control of that address.
 *
 * `preview` is set in console mode and nowhere else, so it is the only honest
 * signal for "never dispatched". These tests exist so the weaker condition
 * cannot come back: every one of them passes under the old code EXCEPT the
 * provider-failure cases, which are the whole point.
 */

function stubPrisma(): PrismaService {
  return {
    otp: {
      findFirst: async () => null, // no cooldown row
      updateMany: async () => ({ count: 0 }),
      create: async () => ({}),
    },
  } as unknown as PrismaService;
}

function stubMail(result: SendResult): MailService {
  return { send: async () => result } as unknown as MailService;
}

function stubSms(result: SendResult): SmsService {
  return { send: async () => result } as unknown as SmsService;
}

function serviceWith(mail: SendResult, sms: SendResult): OtpService {
  return new OtpService(stubPrisma(), stubMail(mail), stubSms(sms));
}

const NEVER_SENT: SendResult = { delivered: false, preview: 'Your TradeW code is 123456.' };
const ACCEPTED: SendResult = { delivered: true };
const PROVIDER_FAILED: SendResult = { delivered: false };

describe('OtpService.request — code disclosure', () => {
  describe('email purposes', () => {
    it('discloses devCode when no mail provider is configured', async () => {
      const res = await serviceWith(NEVER_SENT, ACCEPTED).request('u@example.com', OtpPurpose.login);
      expect(res.devCode).toMatch(/^\d{6}$/);
    });

    it('does not disclose devCode when the provider accepted the message', async () => {
      const res = await serviceWith(ACCEPTED, ACCEPTED).request('u@example.com', OtpPurpose.login);
      expect(res.devCode).toBeUndefined();
    });

    it('does NOT disclose devCode when a configured provider failed', async () => {
      // The regression. Old code returned the code here.
      const res = await serviceWith(PROVIDER_FAILED, ACCEPTED).request('u@example.com', OtpPurpose.login);
      expect(res.devCode).toBeUndefined();
      expect(res).toEqual({});
    });

    it('holds for password_reset too — the highest-value code of the three', async () => {
      const res = await serviceWith(PROVIDER_FAILED, ACCEPTED).request('u@example.com', OtpPurpose.password_reset);
      expect(res.devCode).toBeUndefined();
    });

    it('holds for email_verify', async () => {
      const res = await serviceWith(PROVIDER_FAILED, ACCEPTED).request('u@example.com', OtpPurpose.email_verify);
      expect(res.devCode).toBeUndefined();
    });
  });

  describe('sms purposes', () => {
    it('discloses devCode when no SMS provider is configured', async () => {
      const res = await serviceWith(ACCEPTED, NEVER_SENT).request('+919876543210', OtpPurpose.phone_verify);
      expect(res.devCode).toMatch(/^\d{6}$/);
    });

    it('does not disclose devCode when Twilio accepted the message', async () => {
      const res = await serviceWith(ACCEPTED, ACCEPTED).request('+919876543210', OtpPurpose.phone_verify);
      expect(res.devCode).toBeUndefined();
    });

    it('does NOT disclose devCode when a configured Twilio failed', async () => {
      const res = await serviceWith(ACCEPTED, PROVIDER_FAILED).request('+919876543210', OtpPurpose.phone_verify);
      expect(res.devCode).toBeUndefined();
    });
  });

  it('routes by purpose, not by caller — a mail failure cannot leak via the SMS branch', async () => {
    // phone_verify goes to SMS, so the mail result is irrelevant to it, and
    // vice versa. Guards the routing the disclosure rule is layered on top of.
    const emailRes = await serviceWith(NEVER_SENT, ACCEPTED).request('u@example.com', OtpPurpose.login);
    const smsRes = await serviceWith(NEVER_SENT, ACCEPTED).request('+919876543210', OtpPurpose.phone_verify);
    expect(emailRes.devCode).toMatch(/^\d{6}$/);
    expect(smsRes.devCode).toBeUndefined();
  });
});
