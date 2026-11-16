import { BRAND, esc, layout, paragraph, codeBlock, factRow, type BuiltEmail } from './templates';

/**
 * The centralized email template registry.
 *
 * Every template is DATA: a subject, a heading, paragraphs, optional facts, a
 * call-to-action and a plain-text body, all written with `{{Placeholder}}`
 * tokens. `renderTemplate` fills them in and wraps the result in the shared
 * branded shell from `templates.ts` (wordmark header, card, footer), so every
 * email carries the same logo, header and footer and only the words differ.
 *
 * Rules the renderer enforces:
 *  · Every placeholder must be supplied. A missing value is an error, never a
 *    silently blank sentence.
 *  · Values are HTML-escaped in the HTML part and inserted verbatim in the text
 *    part. Template text itself is static and trusted; user-derived values
 *    (names, addresses) are not.
 *  · A CTA URL must resolve to http(s). A `javascript:` or `data:` URL in an
 *    email signed with our domain is a phishing primitive.
 *
 * VERSIONING. Each template carries an integer `version`, recorded on every
 * row of `EmailDeliveryLog`. Change the version whenever the wording or the
 * placeholders change, so a delivered email can be traced to the exact
 * template that produced it.
 */

export type EmailTemplateKey =
  | 'welcome'
  | 'verify_email'
  | 'resend_verification'
  | 'forgot_password'
  | 'password_reset_confirmation'
  | 'login_security_notification'
  | 'account_info_updated'
  | 'billing_address_updated'
  | 'payment_successful'
  | 'payment_failed'
  | 'order_confirmation'
  | 'order_receipt'
  | 'refund_confirmation'
  | 'payment_method_added'
  | 'payment_method_removed';

export interface EmailTemplateDef {
  key: EmailTemplateKey;
  version: number;
  name: string;
  description: string;
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Label/value rows shown as a small table. Values may hold placeholders. */
  facts?: Array<[label: string, value: string]>;
  /** A placeholder rendered in the big monospace code block (e.g. a reset code). */
  code?: string;
  cta?: { label: string; url: string };
  /** Small muted closing line. */
  footnote?: string;
  /** Sample values for admin preview and test-send. Fictional, example.com only. */
  sample: Record<string, string>;
}

/** Values every template may use without the caller passing them. */
export function globalVars(): Record<string, string> {
  return {
    AppName: BRAND.name,
    AppUrl: BRAND.webUrl,
    SupportEmail: BRAND.supportEmail,
    Year: String(new Date().getUTCFullYear()),
  };
}

const SAMPLE_PERSON = { FirstName: 'Asha', Email: 'asha@example.com' };
const SAMPLE_ORDER = {
  OrderId: 'ord_sample_0001',
  ItemName: 'Sentinel Pro (monthly)',
  Subtotal: '$49.00',
  Tax: '$4.29',
  Total: '$53.29',
  PaidAt: '16 Nov 2026, 10:05 UTC',
  CardLabel: 'Visa ending 4242',
  AccessUntil: '16 Dec 2026',
};

export const EMAIL_TEMPLATES: Record<EmailTemplateKey, EmailTemplateDef> = {
  welcome: {
    key: 'welcome',
    version: 1,
    name: 'Welcome',
    description: 'Sent once, after the email address is verified.',
    subject: 'Welcome to {{AppName}}, {{FirstName}}',
    preheader: 'Your account is ready.',
    heading: 'Welcome aboard, {{FirstName}}',
    paragraphs: [
      'Your {{AppName}} account is verified and ready. You have a full paper-trading account with virtual money, so you can practise without risking real money.',
      'Start with the dashboard, place a paper trade, or explore the Learning Hub.',
    ],
    cta: { label: 'Open your dashboard', url: '{{AppUrl}}/dashboard' },
    footnote: 'Questions? Reply to {{SupportEmail}} and a person will answer.',
    sample: { ...SAMPLE_PERSON },
  },
  verify_email: {
    key: 'verify_email',
    version: 1,
    name: 'Verification',
    description: 'Sent at registration with a single-use verification link.',
    subject: 'Verify your {{AppName}} email address',
    preheader: 'Confirm your email to finish setting up your account.',
    heading: 'Confirm your email, {{FirstName}}',
    paragraphs: [
      'Thanks for registering with {{AppName}}. Confirm that {{Email}} is your address to unlock billing and the rest of your account.',
      'This link works once and expires in {{ExpiresInHours}} hours.',
    ],
    cta: { label: 'Verify my email', url: '{{VerifyUrl}}' },
    footnote: "If you didn't create an account, ignore this email. Nothing happens unless the link is used.",
    sample: { ...SAMPLE_PERSON, ExpiresInHours: '24', VerifyUrl: 'https://example.com/verify-email?token=sample' },
  },
  resend_verification: {
    key: 'resend_verification',
    version: 1,
    name: 'Resend Verification',
    description: 'Sent when a user asks for a new verification link. Earlier links stop working.',
    subject: 'Your new {{AppName}} verification link',
    preheader: 'Here is a fresh link. Older ones no longer work.',
    heading: 'Here is your new link',
    paragraphs: [
      'You asked for a new verification link for {{Email}}. Any link we sent before this one has stopped working.',
      'This link works once and expires in {{ExpiresInHours}} hours.',
    ],
    cta: { label: 'Verify my email', url: '{{VerifyUrl}}' },
    footnote: "If you didn't ask for this, ignore it.",
    sample: { ...SAMPLE_PERSON, ExpiresInHours: '24', VerifyUrl: 'https://example.com/verify-email?token=sample' },
  },
  forgot_password: {
    key: 'forgot_password',
    version: 1,
    name: 'Forgot Password',
    description: 'One-time reset code, sent only when the address has an account.',
    subject: 'Your {{AppName}} password reset code',
    preheader: 'Code {{ResetCode}}, expires in {{ExpiresInMinutes}} minutes.',
    heading: 'Reset your password',
    paragraphs: [
      'Someone asked to reset the password for {{Email}}. Enter this code on the reset page. It works once and expires in {{ExpiresInMinutes}} minutes.',
    ],
    code: '{{ResetCode}}',
    cta: { label: 'Go to the reset page', url: '{{ResetUrl}}' },
    footnote: "If you didn't ask for this, ignore it. Your password stays the same unless the code is used.",
    sample: { ...SAMPLE_PERSON, ResetCode: '482913', ExpiresInMinutes: '10', ResetUrl: 'https://example.com/reset' },
  },
  password_reset_confirmation: {
    key: 'password_reset_confirmation',
    version: 1,
    name: 'Password Reset Confirmation',
    description: 'Sent after a password is reset or changed. All sessions are signed out.',
    subject: 'Your {{AppName}} password was changed',
    preheader: 'Your password was just changed.',
    heading: 'Password changed',
    paragraphs: [
      'The password for {{Email}} was changed on {{When}}. For your safety, every signed-in session was signed out.',
      "If this wasn't you, contact {{SupportEmail}} straight away. Your account may be at risk.",
    ],
    facts: [
      ['When', '{{When}}'],
      ['IP address', '{{Ip}}'],
    ],
    cta: { label: 'Sign in', url: '{{AppUrl}}/login' },
    sample: { ...SAMPLE_PERSON, When: '16 Nov 2026, 10:05 UTC', Ip: '203.0.113.7' },
  },
  login_security_notification: {
    key: 'login_security_notification',
    version: 1,
    name: 'Login Security Notification',
    description: 'Sent on each successful sign-in, and when repeated failures lock the account.',
    subject: '{{AppName}} security notice: {{EventTitle}}',
    preheader: '{{EventTitle}} on your account.',
    heading: '{{EventTitle}}',
    paragraphs: ['{{EventDetail}}', "If this wasn't you, reset your password now and contact {{SupportEmail}}."],
    facts: [
      ['When', '{{When}}'],
      ['Method', '{{Method}}'],
      ['IP address', '{{Ip}}'],
      ['Device', '{{Device}}'],
    ],
    cta: { label: 'Reset my password', url: '{{AppUrl}}/reset' },
    sample: {
      ...SAMPLE_PERSON,
      EventTitle: 'New sign-in',
      EventDetail: 'There was a new sign-in to asha@example.com.',
      When: '16 Nov 2026, 10:05 UTC',
      Method: 'Email and password',
      Ip: '203.0.113.7',
      Device: 'Chrome on Windows',
    },
  },
  account_info_updated: {
    key: 'account_info_updated',
    version: 1,
    name: 'Account Info Updated',
    description: 'Sent when profile details (name, phone) change.',
    subject: 'Your {{AppName}} account details were updated',
    preheader: 'Your profile changed.',
    heading: 'Account details updated',
    paragraphs: [
      'These details on your {{AppName}} account were changed on {{When}}: {{ChangedFields}}.',
      "If you didn't make this change, contact {{SupportEmail}}.",
    ],
    cta: { label: 'Review my profile', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, When: '16 Nov 2026, 10:05 UTC', ChangedFields: 'first name, phone' },
  },
  billing_address_updated: {
    key: 'billing_address_updated',
    version: 1,
    name: 'Billing Address Updated',
    description: 'Sent after a billing or shipping address is saved.',
    subject: 'Your {{AppName}} {{AddressKind}} address was updated',
    preheader: 'Your {{AddressKind}} address changed.',
    heading: '{{AddressKindTitle}} address updated',
    paragraphs: [
      'Your {{AddressKind}} address was updated on {{When}}. It is used for receipts and to work out sales tax.',
      "If you didn't make this change, contact {{SupportEmail}}.",
    ],
    facts: [['New address', '{{AddressSummary}}']],
    cta: { label: 'Review billing details', url: '{{AppUrl}}/settings/billing' },
    sample: {
      ...SAMPLE_PERSON,
      AddressKind: 'billing',
      AddressKindTitle: 'Billing',
      When: '16 Nov 2026, 10:05 UTC',
      AddressSummary: '1 Market St, San Francisco, CA 94105, US',
    },
  },
  payment_successful: {
    key: 'payment_successful',
    version: 1,
    name: 'Payment Successful',
    description: 'Sent when a subscription renewal is paid.',
    subject: '{{AppName}} payment received: {{Total}}',
    preheader: 'Your {{ItemName}} renewal went through.',
    heading: 'Payment received',
    paragraphs: ['Thanks, {{FirstName}}. We received your payment for {{ItemName}}. Your access continues until {{AccessUntil}}.'],
    facts: [
      ['Amount', '{{Total}}'],
      ['Card', '{{CardLabel}}'],
      ['Paid', '{{PaidAt}}'],
      ['Reference', '{{OrderId}}'],
    ],
    cta: { label: 'View billing', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, ...SAMPLE_ORDER },
  },
  payment_failed: {
    key: 'payment_failed',
    version: 1,
    name: 'Payment Failed',
    description: 'Sent when a payment attempt fails. Nothing was charged.',
    subject: 'Your {{AppName}} payment did not go through',
    preheader: 'Nothing was charged. Update your card to try again.',
    heading: "Your payment didn't go through",
    paragraphs: [
      'We could not take payment for {{ItemName}} ({{Total}}). The reason given was: {{Reason}}.',
      'Nothing was charged. You can try again with the same card or a different one.',
    ],
    cta: { label: 'Update payment method', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, ItemName: 'Sentinel Pro (monthly)', Total: '$53.29', Reason: 'Your card was declined.' },
  },
  order_confirmation: {
    key: 'order_confirmation',
    version: 1,
    name: 'Order Confirmation',
    description: 'Sent once an order is paid (confirmed by webhook) and access is granted.',
    subject: 'Order confirmed: {{ItemName}}',
    preheader: '{{ItemName}} is active.',
    heading: "You're all set, {{FirstName}}",
    paragraphs: ['Your order for {{ItemName}} is confirmed and your access is live until {{AccessUntil}}.', 'A separate receipt with the full amounts follows.'],
    facts: [
      ['Order', '{{OrderId}}'],
      ['Plan', '{{ItemName}}'],
      ['Access until', '{{AccessUntil}}'],
    ],
    cta: { label: 'Start using it', url: '{{AccessUrl}}' },
    sample: { ...SAMPLE_PERSON, ...SAMPLE_ORDER, AccessUrl: 'https://example.com/sentinel' },
  },
  order_receipt: {
    key: 'order_receipt',
    version: 1,
    name: 'Order Receipt',
    description: 'Itemised receipt with subtotal, tax and total.',
    subject: 'Your {{AppName}} receipt for {{Total}}',
    preheader: 'Receipt for order {{OrderId}}.',
    heading: 'Receipt',
    paragraphs: ['Here is your receipt. Keep it for your records.'],
    facts: [
      ['Order', '{{OrderId}}'],
      ['Item', '{{ItemName}}'],
      ['Subtotal', '{{Subtotal}}'],
      ['Tax', '{{Tax}}'],
      ['Total', '{{Total}}'],
      ['Paid with', '{{CardLabel}}'],
      ['Paid', '{{PaidAt}}'],
    ],
    cta: { label: 'View billing history', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, ...SAMPLE_ORDER },
  },
  refund_confirmation: {
    key: 'refund_confirmation',
    version: 1,
    name: 'Refund Confirmation',
    description: 'Sent when a charge is refunded in full or in part.',
    subject: '{{AppName}} refund of {{RefundAmount}}',
    preheader: 'A refund is on its way to your card.',
    heading: 'Refund issued',
    paragraphs: [
      'We refunded {{RefundAmount}} for {{ItemName}} (order {{OrderId}}). It usually reaches your card in 5 to 10 business days, depending on your bank.',
      '{{AccessNote}}',
    ],
    facts: [
      ['Refund', '{{RefundAmount}}'],
      ['Order', '{{OrderId}}'],
    ],
    cta: { label: 'View billing', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, ...SAMPLE_ORDER, RefundAmount: '$53.29', AccessNote: 'Access bought with this payment has ended.' },
  },
  payment_method_added: {
    key: 'payment_method_added',
    version: 1,
    name: 'Payment Method Added',
    description: 'Sent when a card is saved to the account.',
    subject: 'A card was added to your {{AppName}} account',
    preheader: '{{CardLabel}} was saved.',
    heading: 'Card added',
    paragraphs: ['{{CardLabel}} (expires {{CardExpiry}}) was saved to your account on {{When}}.', "If you didn't add it, remove it now and contact {{SupportEmail}}."],
    cta: { label: 'Manage cards', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, CardLabel: 'Visa ending 4242', CardExpiry: '12/2030', When: '16 Nov 2026, 10:05 UTC' },
  },
  payment_method_removed: {
    key: 'payment_method_removed',
    version: 1,
    name: 'Payment Method Removed',
    description: 'Sent when a saved card is removed.',
    subject: 'A card was removed from your {{AppName}} account',
    preheader: '{{CardLabel}} was removed.',
    heading: 'Card removed',
    paragraphs: ['{{CardLabel}} was removed from your account on {{When}}. It can no longer be charged by {{AppName}}.', "If you didn't do this, contact {{SupportEmail}}."],
    cta: { label: 'Manage cards', url: '{{AppUrl}}/settings/billing' },
    sample: { ...SAMPLE_PERSON, CardLabel: 'Visa ending 4242', When: '16 Nov 2026, 10:05 UTC' },
  },
};

export class TemplateRenderError extends Error {}

const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** Every placeholder a template references, in first-use order. */
export function placeholdersOf(def: EmailTemplateDef): string[] {
  const parts = [
    def.subject,
    def.preheader,
    def.heading,
    ...def.paragraphs,
    ...(def.facts ?? []).map(([, v]) => v),
    def.code ?? '',
    def.cta?.url ?? '',
    def.cta?.label ?? '',
    def.footnote ?? '',
  ];
  const seen = new Set<string>();
  for (const part of parts) for (const m of part.matchAll(TOKEN)) seen.add(m[1]);
  return [...seen];
}

/** Substitute `{{Tokens}}` with raw values. Throws on a missing value. */
export function fill(template: string, vars: Record<string, string>, key: string): string {
  return template.replace(TOKEN, (_whole, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) {
      throw new TemplateRenderError(`Template "${key}" needs a value for {{${name}}}`);
    }
    return String(value);
  });
}

function ctaButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;"><tr><td style="border-radius:8px;background:${BRAND.accent};">
<a href="${esc(url)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">${esc(label)}</a>
</td></tr></table>`;
}

export interface RenderedEmail extends BuiltEmail {
  key: EmailTemplateKey;
  version: number;
}

/**
 * Render one template. `vars` are merged over `globalVars()`. Optional facts
 * whose value resolves to an empty string are dropped (an IP we don't have is
 * omitted, not shown as a blank row).
 */
export function renderTemplate(key: EmailTemplateKey, vars: Record<string, string | undefined>): RenderedEmail {
  const def = EMAIL_TEMPLATES[key];
  if (!def) throw new TemplateRenderError(`Unknown email template "${key}"`);
  const all: Record<string, string> = { ...globalVars() };
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== null) all[k] = String(v);
  // Facts are optional rows: a missing fact value renders as nothing.
  for (const [, value] of def.facts ?? []) {
    for (const m of value.matchAll(TOKEN)) if (all[m[1]] === undefined) all[m[1]] = '';
  }

  const subject = fill(def.subject, all, key).replace(/[\r\n]+/g, ' ');
  const heading = fill(def.heading, all, key);
  const preheader = fill(def.preheader, all, key);
  const paragraphs = def.paragraphs.map((t) => fill(t, all, key)).filter((t) => t.trim() !== '');
  const facts = (def.facts ?? [])
    .map(([label, value]) => [label, fill(value, all, key)] as const)
    .filter(([, value]) => value.trim() !== '');
  const code = def.code ? fill(def.code, all, key) : undefined;
  const cta = def.cta ? { label: fill(def.cta.label, all, key), url: fill(def.cta.url, all, key) } : undefined;
  const footnote = def.footnote ? fill(def.footnote, all, key) : undefined;

  if (cta && !/^https?:\/\//i.test(cta.url)) {
    throw new TemplateRenderError(`Template "${key}" CTA must be an http(s) URL`);
  }

  const bodyHtml =
    paragraphs.map((t) => paragraph(esc(t))).join('') +
    (code ? codeBlock(code) : '') +
    (facts.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">${facts.map(([l, v]) => factRow(l, v)).join('')}</table>`
      : '') +
    (cta ? ctaButton(cta.label, cta.url) : '') +
    (footnote ? paragraph(`<span style="color:${BRAND.muted};font-size:13px;">${esc(footnote)}</span>`) : '');

  const textLines = [
    heading,
    '',
    ...paragraphs.flatMap((t) => [t, '']),
    ...(code ? [`Code: ${code}`, ''] : []),
    ...(facts.length ? [...facts.map(([l, v]) => `${l}: ${v}`), ''] : []),
    ...(cta ? [`${cta.label}: ${cta.url}`, ''] : []),
    ...(footnote ? [footnote, ''] : []),
    '--',
    `${BRAND.name}: educational market analytics. Not investment advice.`,
    `Questions? ${BRAND.supportEmail}`,
  ];

  return {
    key,
    version: def.version,
    subject,
    text: textLines.join('\n'),
    html: layout({ preheader, heading, bodyHtml }),
  };
}

export function listTemplates() {
  return Object.values(EMAIL_TEMPLATES).map((def) => ({
    key: def.key,
    version: def.version,
    name: def.name,
    description: def.description,
    placeholders: placeholdersOf(def).filter((p) => !(p in globalVars())),
  }));
}
