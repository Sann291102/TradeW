import { Injectable, Logger } from '@nestjs/common';

/**
 * Outbound SMS — the whole application's only sender.
 *
 * Mirrors MailService deliberately, including the console fallback: swapping
 * providers should be a credential change, not a code change, so this talks to
 * Twilio's REST endpoint over plain `fetch` rather than pulling in an SDK. A
 * different provider is a new branch in `deliver()`, not a new dependency.
 *
 * WHEN SMS IS NOT CONFIGURED the code is logged instead of sent. That is what
 * makes phone sign-in testable on a machine with no Twilio account: the OTP
 * lands in the API log, the flow completes end to end, and `delivered: false`
 * is how the caller knows to surface the dev code rather than pretend an SMS
 * went out. Sending real SMS costs money per message — nothing here should
 * start doing that implicitly because an env var appeared.
 */

export interface SmsResult {
  delivered: boolean;
  /** Populated only in console-fallback mode, for local testing. */
  preview?: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly sid = process.env.TWILIO_ACCOUNT_SID;
  private readonly token = process.env.TWILIO_AUTH_TOKEN;
  private readonly from = process.env.TWILIO_FROM;
  private readonly configured: boolean;

  constructor() {
    this.configured = Boolean(this.sid && this.token && this.from);
    if (!this.configured) {
      this.logger.warn(
        'SMS not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM) — codes will be logged, not sent',
      );
    } else {
      this.logger.log(`SMS ready: Twilio from ${this.from}`);
    }
  }

  async send(to: string, text: string): Promise<SmsResult> {
    if (!this.configured) {
      this.logger.warn(`[sms:console] to=${to}\n${text}`);
      return { delivered: false, preview: text };
    }

    try {
      const body = new URLSearchParams({ To: to, From: this.from!, Body: text });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization:
              'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );

      if (!res.ok) {
        // Read the provider's reason into the operator log, but never return
        // it — an error body can distinguish "unroutable number" from "number
        // not in service", which is a weak enumeration signal.
        const detail = await res.text().catch(() => '');
        this.logger.error(`Twilio rejected send to ${to}: ${res.status} ${detail.slice(0, 200)}`);
        return { delivered: false };
      }

      this.logger.log(`sent SMS to ${to}`);
      return { delivered: true };
    } catch (err) {
      // Same contract as MailService.send: never propagate. A provider outage
      // must not become a 500 that tells a caller whether the number exists.
      this.logger.error(
        `SMS to ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { delivered: false };
    }
  }
}
