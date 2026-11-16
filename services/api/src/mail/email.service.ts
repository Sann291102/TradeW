import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService, type SendResult } from './mail.service';
import { renderTemplate, type EmailTemplateKey } from './email-templates';

export interface TemplateSendOptions {
  userId?: string | null;
  /** Admin test-send. Logged with isTest=true so it never counts as customer mail. */
  isTest?: boolean;
}

export interface TemplateSendResult extends SendResult {
  logId?: string;
  attempts: number;
}

/** Retry schedule for transient failures: immediate, then 0.5s, then 2s. */
const BACKOFF_MS = [0, 500, 2000];

/**
 * The template-driven sender: render → send (with retry) → log.
 *
 * Sits on top of `MailService`, which stays the single transport. Every send
 * writes one `EmailDeliveryLog` row recording the template key and version,
 * the outcome, the attempt count and the sanitised error. The rendered body is
 * NOT stored: verification and reset emails carry credentials.
 *
 * Retries only happen for failures `MailService` marks `transient` (timeouts,
 * SMTP 4xx, HTTP 429/5xx). A permanent refusal is logged once and left alone.
 *
 * Never throws for a delivery failure. A rendering error (a missing
 * placeholder) DOES throw, because that is a bug in the caller, and hiding it
 * would turn into an email that silently never exists.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Synthetic phone-signup addresses are nobody's mailbox. */
  static isDeliverable(address: string | null | undefined): address is string {
    return Boolean(address) && !address!.endsWith('@phone.tradew.local');
  }

  async sendTemplate(
    key: EmailTemplateKey,
    to: string,
    vars: Record<string, string | undefined>,
    opts: TemplateSendOptions = {},
  ): Promise<TemplateSendResult> {
    const rendered = renderTemplate(key, vars);
    if (!EmailService.isDeliverable(to)) return { delivered: false, attempts: 0 };

    let result: SendResult = { delivered: false };
    let attempts = 0;
    for (const delay of BACKOFF_MS) {
      if (delay) await sleep(delay);
      attempts += 1;
      result = await this.mail.send(to, rendered.subject, rendered.text, rendered.html);
      if (result.delivered || result.preview !== undefined || !result.transient) break;
    }

    const status = result.delivered ? 'sent' : result.preview !== undefined ? 'console' : 'failed';
    let logId: string | undefined;
    try {
      const row = await this.prisma.emailDeliveryLog.create({
        data: {
          templateKey: key,
          templateVersion: rendered.version,
          toAddress: to,
          subject: rendered.subject,
          status,
          provider: this.mail.provider,
          attempts,
          lastError: result.error ?? null,
          isTest: Boolean(opts.isTest),
          userId: opts.userId ?? null,
          sentAt: result.delivered ? new Date() : null,
        },
        select: { id: true },
      });
      logId = row.id;
    } catch (err) {
      // The log is diagnostics; it must never fail the business flow.
      this.logger.warn(`delivery log write failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ...result, attempts, logId };
  }

  /** Fire-and-forget form for flows that must not wait on or fail with mail. */
  dispatch(key: EmailTemplateKey, to: string | null | undefined, vars: Record<string, string | undefined>, opts: TemplateSendOptions = {}): void {
    if (!EmailService.isDeliverable(to)) return;
    void this.sendTemplate(key, to, vars, opts).catch((err) =>
      this.logger.error(`template ${key} failed to render: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
