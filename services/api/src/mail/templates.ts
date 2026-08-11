/**
 * Branded HTML (+ plain-text) email templates.
 *
 * Every outbound email in the platform is built here so the look, the sender
 * voice and the footer/legal line stay in exactly one place. Each builder
 * returns `{ subject, text, html }` — the shape `MailService.send` consumes —
 * so a caller never hand-assembles a subject or forgets the text fallback.
 *
 * Constraints that shaped this file:
 *  · NO template engine, NO external asset. Email clients (Gmail, Outlook,
 *    Apple Mail) strip <style> blocks, <link>ed CSS and remote fonts
 *    unpredictably, so everything is inline styles on a table skeleton — the
 *    only layout email clients agree on. The logo is CSS text, not an image,
 *    so there is nothing to host and nothing to be blocked as a tracking pixel.
 *  · TEXT IS NOT OPTIONAL. Every builder produces a real plain-text body, not
 *    a stripped-HTML afterthought — it is what SMS-to-email gateways, screen
 *    readers and spam filters actually read.
 *  · The palette mirrors the app's teal/ink identity so an email reads as the
 *    same product as the workspace it came from.
 */

/** The one place the product's outward identity is spelled. */
const BRAND = {
  name: 'TradeW',
  tagline: 'Setup',
  // App teal. Kept as a hex literal (not a CSS var) — email clients have no
  // access to the app's stylesheet.
  accent: '#0f9e8e',
  ink: '#0b1220',
  muted: '#5b6b7a',
  bg: '#f4f6f8',
  card: '#ffffff',
  border: '#e3e8ee',
  // Where "not you? / manage" links point. Overridable so staging emails don't
  // send people to production.
  webUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  supportEmail: process.env.SUPPORT_EMAIL || 'admin@tradew-setup.com',
};

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

/** HTML-escape a value before it is dropped into markup. User-derived strings
 *  (emails, device names, symbols) pass through here so none of them can inject
 *  tags into an email we sign with our own domain. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shell every email shares: centred card, wordmark header, muted footer.
 * `bodyHtml` is trusted markup the caller has already escaped; `preheader` is
 * the grey snippet inbox previews show before the body (kept short and factual).
 */
function layout(opts: { preheader: string; heading: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:22px 28px;border-bottom:1px solid ${BRAND.border};">
<span style="font-size:18px;font-weight:800;letter-spacing:-.02em;color:${BRAND.ink};">${BRAND.name}</span><span style="font-size:18px;font-weight:800;color:${BRAND.accent};">·${BRAND.tagline}</span>
</td></tr>
<tr><td style="padding:28px 28px 8px;">
<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:${BRAND.ink};font-weight:700;">${esc(opts.heading)}</h1>
${opts.bodyHtml}
</td></tr>
<tr><td style="padding:20px 28px 26px;border-top:1px solid ${BRAND.border};">
<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">
You are receiving this because this address is registered with ${BRAND.name}.
Questions? <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.accent};text-decoration:none;">${BRAND.supportEmail}</a>.
</p>
<p style="margin:8px 0 0;font-size:11px;color:${BRAND.muted};">${BRAND.name} · ${BRAND.tagline} — educational market analytics. Not investment advice.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** A muted paragraph. */
function p(html: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${BRAND.ink};">${html}</p>`;
}

/** The big monospace one-time code block. */
function codeBlock(code: string): string {
  return `<div style="margin:8px 0 18px;padding:16px;text-align:center;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;">
<span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:${BRAND.ink};">${esc(code)}</span>
</div>`;
}

/** A small labelled fact row (device / IP / when). */
function factRow(label: string, value: string): string {
  return `<tr>
<td style="padding:6px 0;font-size:12px;color:${BRAND.muted};width:96px;vertical-align:top;">${esc(label)}</td>
<td style="padding:6px 0;font-size:13px;color:${BRAND.ink};">${esc(value)}</td>
</tr>`;
}

// ─────────────────────────────────────────────────────────── OTP / security code

export function otpCode(opts: {
  code: string;
  purpose: 'login' | 'password_reset' | 'email_verify';
  minutes: number;
}): BuiltEmail {
  const intent = {
    login: { subject: 'Your TradeW sign-in code', heading: 'Your sign-in code' },
    password_reset: { subject: 'Your TradeW password reset code', heading: 'Reset your password' },
    email_verify: { subject: 'Verify your TradeW email', heading: 'Confirm your email' },
  }[opts.purpose];

  const body =
    p('Use this one-time code to continue. It expires in ' + `<strong>${opts.minutes} minutes</strong>.`) +
    codeBlock(opts.code) +
    p(`<span style="color:${BRAND.muted};font-size:13px;">If you didn't request this, you can safely ignore this email — the code is useless without your account.</span>`);

  return {
    subject: intent.subject,
    text: `Your ${BRAND.name} code is ${opts.code}\n\nIt expires in ${opts.minutes} minutes. If you didn't request it, ignore this email.`,
    html: layout({ preheader: `Code ${opts.code} — expires in ${opts.minutes} min`, heading: intent.heading, bodyHtml: body }),
  };
}

// ─────────────────────────────────────────────────────────────────── login alert

export function loginAlert(opts: {
  email: string;
  method: 'password' | 'google' | 'phone';
  when: string;
  ip?: string;
  userAgent?: string;
}): BuiltEmail {
  const methodLabel = { password: 'Email & password', google: 'Google', phone: 'Phone / OTP' }[opts.method];
  const facts =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">` +
    factRow('When', opts.when) +
    factRow('Method', methodLabel) +
    (opts.ip ? factRow('IP', opts.ip) : '') +
    (opts.userAgent ? factRow('Device', opts.userAgent) : '') +
    `</table>`;

  const body =
    p(`There was a new sign-in to your ${BRAND.name} account <strong>${esc(opts.email)}</strong>.`) +
    facts +
    p(`If this was you, no action is needed. If it wasn't, <a href="${esc(BRAND.webUrl)}/reset" style="color:${BRAND.accent};text-decoration:none;font-weight:600;">reset your password</a> immediately and contact ${esc(BRAND.supportEmail)}.`);

  return {
    subject: `New sign-in to your ${BRAND.name} account`,
    text: `New sign-in to your ${BRAND.name} account ${opts.email}.\n\nWhen: ${opts.when}\nMethod: ${methodLabel}${opts.ip ? `\nIP: ${opts.ip}` : ''}${opts.userAgent ? `\nDevice: ${opts.userAgent}` : ''}\n\nIf this wasn't you, reset your password at ${BRAND.webUrl}/reset and contact ${BRAND.supportEmail}.`,
    html: layout({ preheader: `New sign-in via ${methodLabel}`, heading: 'New sign-in detected', bodyHtml: body }),
  };
}

// ──────────────────────────────────────────────────────────────── password changed

export function passwordChanged(opts: { email: string; when: string; ip?: string }): BuiltEmail {
  const body =
    p(`The password for your ${BRAND.name} account <strong>${esc(opts.email)}</strong> was just changed${opts.ip ? ` from IP ${esc(opts.ip)}` : ''} at ${esc(opts.when)}.`) +
    p('For your security, every other active session was signed out.') +
    p(`<strong>Didn't do this?</strong> Contact <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.accent};text-decoration:none;">${BRAND.supportEmail}</a> right away — your account may be at risk.`);

  return {
    subject: `Your ${BRAND.name} password was changed`,
    text: `The password for your ${BRAND.name} account ${opts.email} was changed at ${opts.when}${opts.ip ? ` from IP ${opts.ip}` : ''}. All other sessions were signed out.\n\nIf this wasn't you, contact ${BRAND.supportEmail} immediately.`,
    html: layout({ preheader: 'Your password was just changed', heading: 'Password changed', bodyHtml: body }),
  };
}

// ────────────────────────────────────────────────────────────── EOD portfolio summary

export interface EodOrderLine {
  symbol: string;
  side: string;
  qty: number;
  price: number;
  status: string;
}

export function eodSummary(opts: {
  email: string;
  dateLabel: string;
  currency: string;
  portfolioValue?: number;
  dayPnl?: number;
  orders: EodOrderLine[];
}): BuiltEmail {
  const money = (n?: number) =>
    n === undefined ? '—' : `${opts.currency}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const pnlColor = (opts.dayPnl ?? 0) >= 0 ? BRAND.accent : '#c0392b';

  const stat = (label: string, value: string, color = BRAND.ink) =>
    `<td style="padding:12px 14px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;">
<div style="font-size:11px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
<div style="font-size:18px;font-weight:700;color:${color};margin-top:2px;">${esc(value)}</div></td>`;

  const stats =
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 18px;"><tr>` +
    stat('Portfolio value', money(opts.portfolioValue)) +
    `<td style="width:12px;"></td>` +
    stat("Today's P&L", `${(opts.dayPnl ?? 0) >= 0 ? '+' : ''}${money(opts.dayPnl)}`, pnlColor) +
    `</tr></table>`;

  const orderRows = opts.orders.length
    ? opts.orders
        .map(
          (o) => `<tr>
<td style="padding:8px 6px;font-size:13px;color:${BRAND.ink};font-weight:600;">${esc(o.symbol)}</td>
<td style="padding:8px 6px;font-size:12px;color:${BRAND.muted};">${esc(o.side)}</td>
<td style="padding:8px 6px;font-size:12px;color:${BRAND.ink};text-align:right;">${esc(o.qty)}</td>
<td style="padding:8px 6px;font-size:12px;color:${BRAND.ink};text-align:right;">${esc(money(o.price))}</td>
<td style="padding:8px 6px;font-size:11px;color:${BRAND.muted};text-align:right;">${esc(o.status)}</td>
</tr>`,
        )
        .join('')
    : `<tr><td colspan="5" style="padding:14px 6px;font-size:13px;color:${BRAND.muted};text-align:center;">No orders today.</td></tr>`;

  const ordersTable =
    `<div style="font-size:12px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.04em;margin:6px 0 6px;">Today's orders</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid ${BRAND.border};margin-bottom:14px;">${orderRows}</table>`;

  const body = p(`Here's your ${BRAND.name} wrap-up for <strong>${esc(opts.dateLabel)}</strong>.`) + stats + ordersTable +
    p(`<a href="${esc(BRAND.webUrl)}/portfolio" style="color:${BRAND.accent};text-decoration:none;font-weight:600;">Open your portfolio →</a>`);

  const textOrders = opts.orders.length
    ? opts.orders.map((o) => `  ${o.symbol}  ${o.side}  ${o.qty} @ ${money(o.price)}  [${o.status}]`).join('\n')
    : '  No orders today.';

  return {
    subject: `${BRAND.name} daily summary — ${opts.dateLabel}`,
    text: `Your ${BRAND.name} summary for ${opts.dateLabel}\n\nPortfolio value: ${money(opts.portfolioValue)}\nToday's P&L: ${money(opts.dayPnl)}\n\nOrders:\n${textOrders}\n\nOpen your portfolio: ${BRAND.webUrl}/portfolio`,
    html: layout({ preheader: `P&L ${money(opts.dayPnl)} · ${opts.orders.length} orders`, heading: 'Your daily summary', bodyHtml: body }),
  };
}

// ─────────────────────────────────────────────────────────────────── payments

/** A labelled amount / plan / reference row block, shared by the payment mails. */
function receiptRows(rows: Array<[string, string]>): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">` +
    rows.map(([l, v]) => factRow(l, v)).join('') +
    `</table>`
  );
}

export function paymentProcessing(opts: {
  email: string;
  itemLabel: string;
  amountLabel: string;
  when: string;
}): BuiltEmail {
  const body =
    p(`We've received your payment request for <strong>${esc(opts.itemLabel)}</strong> and it's being processed.`) +
    receiptRows([['Item', opts.itemLabel], ['Amount', opts.amountLabel], ['Started', opts.when]]) +
    p(`<span style="color:${BRAND.muted};font-size:13px;">You'll get a confirmation the moment it clears — usually within a minute. No need to pay again.</span>`);
  return {
    subject: `${BRAND.name} — payment processing`,
    text: `We've received your payment request for ${opts.itemLabel} (${opts.amountLabel}) at ${opts.when} and it's being processed. You'll get a confirmation shortly.`,
    html: layout({ preheader: `Processing ${opts.amountLabel}`, heading: 'Payment processing', bodyHtml: body }),
  };
}

export function paymentReceipt(opts: {
  email: string;
  itemLabel: string;
  amountLabel: string;
  paymentId: string;
  when: string;
  activeUntil?: string;
}): BuiltEmail {
  const body =
    p(`Your payment succeeded — <strong>${esc(opts.itemLabel)}</strong> is now active on ${esc(opts.email)}. Thank you.`) +
    receiptRows([
      ['Item', opts.itemLabel],
      ['Amount paid', opts.amountLabel],
      ['Payment ID', opts.paymentId],
      ['Date', opts.when],
      ...(opts.activeUntil ? ([['Active until', opts.activeUntil]] as Array<[string, string]>) : []),
    ]) +
    p(`<a href="${esc(BRAND.webUrl)}/sentinel" style="color:${BRAND.accent};text-decoration:none;font-weight:600;">Open your workspace →</a>`) +
    p(`<span style="color:${BRAND.muted};font-size:12px;">This email is your receipt. Keep it for your records.</span>`);
  return {
    subject: `${BRAND.name} receipt — ${opts.itemLabel}`,
    text: `Payment successful. ${opts.itemLabel} is now active.\n\nAmount paid: ${opts.amountLabel}\nPayment ID: ${opts.paymentId}\nDate: ${opts.when}${opts.activeUntil ? `\nActive until: ${opts.activeUntil}` : ''}\n\nThis email is your receipt.`,
    html: layout({ preheader: `Receipt · ${opts.amountLabel}`, heading: 'Payment successful', bodyHtml: body }),
  };
}

export function paymentFailed(opts: {
  email: string;
  itemLabel: string;
  amountLabel: string;
  when: string;
  reason?: string;
}): BuiltEmail {
  const body =
    p(`Your payment for <strong>${esc(opts.itemLabel)}</strong> didn't go through, so nothing was charged.`) +
    receiptRows([
      ['Item', opts.itemLabel],
      ['Amount', opts.amountLabel],
      ['Attempted', opts.when],
      ...(opts.reason ? ([['Reason', opts.reason]] as Array<[string, string]>) : []),
    ]) +
    p(`You can try again anytime: <a href="${esc(BRAND.webUrl)}/checkout" style="color:${BRAND.accent};text-decoration:none;font-weight:600;">return to checkout</a>. If the amount was debited it will be auto-reversed by your bank.`);
  return {
    subject: `${BRAND.name} — payment could not be completed`,
    text: `Your payment for ${opts.itemLabel} (${opts.amountLabel}) at ${opts.when} did not complete, so nothing was charged.${opts.reason ? ` Reason: ${opts.reason}.` : ''}\n\nTry again: ${BRAND.webUrl}/checkout`,
    html: layout({ preheader: 'Payment did not complete', heading: 'Payment not completed', bodyHtml: body }),
  };
}

export const MailTemplates = { otpCode, loginAlert, passwordChanged, eodSummary, paymentProcessing, paymentReceipt, paymentFailed };
