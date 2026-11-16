/**
 * Mail provider configuration, resolved once from the environment.
 *
 * The canonical keys are the `EMAIL_*` family:
 *
 *   EMAIL_PROVIDER       smtp | sendgrid | console   (optional, derived when absent)
 *   EMAIL_HOST / EMAIL_PORT / EMAIL_USERNAME / EMAIL_PASSWORD
 *   EMAIL_FROM_ADDRESS / EMAIL_FROM_NAME
 *
 * Every deployment that predates them configures mail with `SMTP_HOST`,
 * `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `SENDGRID_API_KEY`.
 * Those still work: each `EMAIL_*` key falls back to its older twin, so
 * adopting the new names is optional and never a breaking change.
 */

export type MailProvider = 'smtp' | 'sendgrid' | 'console';

export interface MailConfig {
  provider: MailProvider;
  /** RFC 5322 From header, e.g. `TradeW <no-reply@example.com>`. */
  from: string;
  smtp?: { host: string; port: number; user: string; pass: string };
  sendgridKey?: string;
  /** Why the resolved provider differs from the requested one, if it does. */
  warning?: string;
}

const DEFAULT_FROM = 'TradeW <no-reply@tradew.local>';

export function resolveMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const requested = (env.EMAIL_PROVIDER || '').trim().toLowerCase();

  const host = env.EMAIL_HOST || env.SMTP_HOST;
  const port = Number(env.EMAIL_PORT || env.SMTP_PORT || 587);
  const user = env.EMAIL_USERNAME || env.SMTP_USER;
  const pass = env.EMAIL_PASSWORD || env.SMTP_PASS;
  // SendGrid authenticates with an API key. With EMAIL_PROVIDER=sendgrid the key
  // may be given as EMAIL_PASSWORD (SendGrid's SMTP relay uses it as the
  // password too), so one set of EMAIL_* keys configures either transport.
  const sendgridKey = env.SENDGRID_API_KEY || (requested === 'sendgrid' ? env.EMAIL_PASSWORD : undefined);

  const fromAddress = (env.EMAIL_FROM_ADDRESS || '').trim();
  const fromName = (env.EMAIL_FROM_NAME || '').trim().replace(/[<>"]/g, '');
  const from = fromAddress
    ? fromName
      ? `${fromName} <${fromAddress}>`
      : fromAddress
    : env.MAIL_FROM || DEFAULT_FROM;

  const smtp = host && user && pass ? { host, port, user, pass } : undefined;

  if (requested === 'console') return { provider: 'console', from };
  if (requested === 'smtp') {
    return smtp
      ? { provider: 'smtp', from, smtp }
      : { provider: 'console', from, warning: 'EMAIL_PROVIDER=smtp but EMAIL_HOST/EMAIL_USERNAME/EMAIL_PASSWORD are incomplete; logging mail instead' };
  }
  if (requested === 'sendgrid') {
    return sendgridKey
      ? { provider: 'sendgrid', from, sendgridKey }
      : { provider: 'console', from, warning: 'EMAIL_PROVIDER=sendgrid but no SENDGRID_API_KEY/EMAIL_PASSWORD is set; logging mail instead' };
  }
  if (requested) {
    return { provider: 'console', from, warning: `Unknown EMAIL_PROVIDER "${requested}"; logging mail instead` };
  }

  // No explicit choice: the historical precedence. SendGrid wins when its key
  // is present, then SMTP, then console.
  if (sendgridKey) return { provider: 'sendgrid', from, sendgridKey };
  if (smtp) return { provider: 'smtp', from, smtp };
  return { provider: 'console', from };
}
