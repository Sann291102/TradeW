import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Outbound email — the whole application's only sender.
 *
 * Generic SMTP (Gmail app password in dev). Deliberately NOT a provider SDK:
 * SMTP config is a handful of env vars, so swapping Gmail for SES or Resend
 * later is a credential change rather than a code change.
 *
 * WHEN SMTP IS NOT CONFIGURED the transport is not created and mail is logged
 * to the console instead of thrown away or crashed on. That keeps the OTP
 * flows fully exercisable on a machine with no mail credentials — the code
 * lands in the log, the flow completes, nothing silently pretends to have
 * delivered. `delivered: false` in the return value is how callers tell the
 * difference.
 */

export interface SendResult {
  delivered: boolean;
  /** Populated only in console-fallback mode, for local testing. */
  preview?: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport: nodemailer.Transporter | null = null;
  private readonly from = process.env.MAIL_FROM || 'TradeW <no-reply@tradew.local>';

  constructor() {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      this.logger.warn('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — emails will be logged, not sent');
      return;
    }
    const port = Number(process.env.SMTP_PORT || 587);
    this.transport = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 upgrades via STARTTLS. Deriving this from the
      // port avoids a second env var that can disagree with the first.
      secure: port === 465,
      auth: { user, pass },
    });
    this.logger.log(`SMTP ready: ${user} via ${host}:${port}`);
  }

  async send(to: string, subject: string, text: string, html?: string): Promise<SendResult> {
    if (!this.transport) {
      this.logger.warn(`[mail:console] to=${to} subject="${subject}"\n${text}`);
      return { delivered: false, preview: text };
    }
    try {
      await this.transport.sendMail({ from: this.from, to, subject, text, html });
      this.logger.log(`sent "${subject}" to ${to}`);
      return { delivered: true };
    } catch (err) {
      // Never propagate: a failed send must not turn into a 500 that tells an
      // attacker whether the address exists. The caller's flow continues and
      // the operator sees the failure here.
      this.logger.error(`send to ${to} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { delivered: false };
    }
  }
}
