import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { resolveMailConfig, type MailProvider } from './mail-config';

/**
 * Outbound email — the whole application's only sender.
 *
 * Three delivery modes, chosen once at construction and never mixed:
 *
 *   SENDGRID  `SENDGRID_API_KEY` set. One HTTPS POST to SendGrid's v3 API.
 *   SMTP      `SMTP_HOST`/`_USER`/`_PASS` set. Generic SMTP via nodemailer.
 *   CONSOLE   neither. The message is logged, not sent.
 *
 * ── WHY BOTH, RATHER THAN SENDGRID REPLACING SMTP ─────────────────────────
 *
 * Generic SMTP was a deliberate choice, not an accident to be undone: it is
 * the reason moving from Gmail to SES to Resend has always been a credential
 * change rather than a code change. Deleting it to hard-wire one vendor's API
 * would trade that away, and would break every existing deployment's config on
 * the same commit. SendGrid is added ALONGSIDE it and simply wins when its key
 * is present, so both properties survive: nothing that works today stops
 * working, and there is now a path that does not depend on SMTP being routable.
 *
 * ── AND WHY SENDGRID AT ALL ───────────────────────────────────────────────
 *
 * SMTP needs port 587 open outbound. Azure restricts outbound SMTP on many
 * subscription types, and it is not a setting the application can win an
 * argument with. The v3 API is an ordinary HTTPS request on 443 — the same
 * port every other outbound call in this service already uses, and one no
 * host blocks. That is the whole reason this mode exists.
 *
 * ── AND WHY NO SDK ────────────────────────────────────────────────────────
 *
 * The surface needed is a single POST with a JSON body. One request does not
 * justify a vendor SDK: `fetch` does it in one method, versus adding and tracking `@sendgrid/mail`
 * and its dependency tree for the same request.
 *
 * ── UNCONFIGURED IS A FIRST-CLASS STATE, AND `preview` IS HOW YOU TELL ────
 *
 * With no provider configured the message is logged and `preview` is set. This
 * keeps the OTP flows fully exercisable on a machine with no mail credentials.
 *
 * `preview` is populated in CONSOLE MODE AND NOWHERE ELSE, and callers depend
 * on that distinction for more than cosmetics: `OtpService` returns the code
 * in the HTTP response when — and only when — it was never dispatched to a
 * provider. `delivered: false` does not carry that meaning, because a
 * configured provider that returns 429 also produces `delivered: false`. Any
 * caller deciding whether it is safe to disclose message contents must branch
 * on `preview`, never on `!delivered`. See `OtpService.request`.
 */

export interface SendResult {
  /** True only when a provider accepted the message. */
  delivered: boolean;
  /**
   * The message body, populated ONLY when no provider was configured and the
   * mail was logged instead of sent. Its presence is the proof that the
   * content never left this process — never infer that from `!delivered`.
   */
  preview?: string;
  /** Sanitised failure reason when a configured provider refused or errored. */
  error?: string;
  /**
   * True when the failure is worth retrying: a network error, a timeout, an
   * SMTP 4xx, or an HTTP 429/5xx. Permanent refusals (bad address, bad key,
   * unverified sender) are false; retrying them only burns sender reputation.
   */
  transient?: boolean;
}

type Mode = MailProvider;

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

/**
 * An unbounded outbound call would hold the caller's HTTP request open for as
 * long as the provider felt like stalling. Signup is a user-facing path, so it
 * gives up and reports the failure instead.
 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * `MAIL_FROM` is authored in RFC 5322 form (`TradeW · Setup <admin@x.com>`)
 * because that is what SMTP takes verbatim. SendGrid wants the display name
 * and the address as separate JSON fields, so it is split here rather than
 * asking operators to maintain a second env var that can disagree with the
 * first.
 */
export function parseMailFrom(raw: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/.exec(raw);
  if (!match) return { email: raw.trim() };
  const name = match[1].replace(/^"(.*)"$/, '$1').trim();
  return { email: match[2].trim(), ...(name ? { name } : {}) };
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly mode: Mode;
  private readonly from: string;
  private readonly sendgridKey?: string;
  private transport: nodemailer.Transporter | null = null;

  constructor() {
    // EMAIL_* keys first, legacy SMTP_*/MAIL_FROM/SENDGRID_API_KEY as fallback.
    const cfg = resolveMailConfig();
    this.from = cfg.from;
    if (cfg.warning) this.logger.warn(cfg.warning);

    if (cfg.provider === 'sendgrid') {
      // SendGrid wins when both are set. An operator who has added an API key
      // has chosen the HTTPS path; silently preferring leftover SMTP variables
      // would send mail over the transport they were trying to move off.
      this.mode = 'sendgrid';
      this.sendgridKey = cfg.sendgridKey;
      this.logger.log(`SendGrid ready: sending as ${this.from}`);
      return;
    }

    if (cfg.provider === 'console' || !cfg.smtp) {
      this.mode = 'console';
      this.logger.warn(
        'No mail provider configured (set EMAIL_PROVIDER + EMAIL_HOST/EMAIL_USERNAME/EMAIL_PASSWORD, or the legacy SENDGRID_API_KEY / SMTP_*). Emails will be logged, not sent',
      );
      return;
    }

    const { host, port, user, pass } = cfg.smtp;
    this.mode = 'smtp';
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
    if (this.mode === 'console') {
      this.logger.warn(`[mail:console] to=${to} subject="${subject}"\n${text}`);
      return { delivered: false, preview: text };
    }

    try {
      if (this.mode === 'sendgrid') await this.sendViaSendgrid(to, subject, text, html);
      else await this.transport!.sendMail({ from: this.from, to, subject, text, html });
      this.logger.log(`sent "${subject}" to ${to}`);
      return { delivered: true };
    } catch (err) {
      // Never propagate: a failed send must not turn into a 500 that tells an
      // attacker whether the address exists. The caller's flow continues and
      // the operator sees the failure here.
      //
      // Note the absent `preview`. A provider was configured and the message
      // was handed to it, so the content may well have gone out — this process
      // cannot prove otherwise, and must not imply it did not.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`send to ${to} failed: ${message}`);
      return { delivered: false, error: message.slice(0, 300), transient: isTransientMailError(err) };
    }
  }

  /** Which transport this process resolved to, for the delivery log. */
  get provider(): Mode {
    return this.mode;
  }

  private async sendViaSendgrid(to: string, subject: string, text: string, html?: string): Promise<void> {
    const from = parseMailFrom(this.from);
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.sendgridKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from,
        subject,
        // Order matters to SendGrid: it requires ascending MIME preference, so
        // text/plain must precede text/html or the request is rejected.
        content: [
          { type: 'text/plain', value: text },
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    // 202 Accepted, empty body, is success. Anything else carries a JSON error
    // body worth surfacing — a wrong key is a 401 and an unverified sender a
    // 403, and those are indistinguishable from "mail is broken" without it.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const error = new Error(`SendGrid responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }
  }
}

/**
 * Is this send failure worth another attempt?
 *
 * Transient: connection and timeout errors, SMTP 4xx replies (greylisting,
 * rate limits), HTTP 429 and 5xx from SendGrid. Everything else (a rejected
 * address, a wrong key, an unverified sender) fails the same way every time.
 */
export function isTransientMailError(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number; status?: number; name?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.status === 'number') return e.status === 429 || e.status >= 500;
  if (typeof e.responseCode === 'number') return e.responseCode >= 400 && e.responseCode < 500;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  return ['ECONNECTION', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN'].includes(
    e.code ?? '',
  );
}
