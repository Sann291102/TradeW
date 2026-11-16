import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATES, listTemplates, placeholdersOf, renderTemplate, TemplateRenderError, type EmailTemplateKey } from './email-templates';
import { resolveMailConfig } from './mail-config';
import { isTransientMailError } from './mail.service';

const KEYS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateKey[];

describe('email template registry', () => {
  it('has exactly the 15 required templates', () => {
    expect(KEYS.sort()).toEqual(
      [
        'account_info_updated',
        'billing_address_updated',
        'forgot_password',
        'login_security_notification',
        'order_confirmation',
        'order_receipt',
        'password_reset_confirmation',
        'payment_failed',
        'payment_method_added',
        'payment_method_removed',
        'payment_successful',
        'refund_confirmation',
        'resend_verification',
        'verify_email',
        'welcome',
      ].sort(),
    );
  });

  it.each(KEYS)('%s renders from its sample with header, footer, CTA and a plain-text part', (key) => {
    const def = EMAIL_TEMPLATES[key];
    const out = renderTemplate(key, def.sample);
    expect(out.version).toBeGreaterThanOrEqual(1);
    expect(out.subject).not.toMatch(/\{\{/);
    expect(out.html).not.toMatch(/\{\{/);
    expect(out.text).not.toMatch(/\{\{/);
    // Branded shell: wordmark header + footer line, inline CSS only.
    expect(out.html).toContain('TradeW');
    expect(out.html).toContain('Not investment advice');
    expect(out.html).not.toMatch(/<style|<link/i);
    expect(out.html).toContain('max-width:520px');
    if (def.cta) {
      expect(out.html).toContain('href="');
      expect(out.text).toContain(def.cta.label);
    }
    expect(out.text.length).toBeGreaterThan(40);
  });

  it('escapes user-supplied values in HTML but keeps them verbatim in text', () => {
    const out = renderTemplate('welcome', { FirstName: '<script>alert(1)</script>' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.text).toContain('<script>alert(1)</script>');
  });

  it('refuses to render with a missing placeholder', () => {
    expect(() => renderTemplate('verify_email', { FirstName: 'A', Email: 'a@example.com' })).toThrow(TemplateRenderError);
  });

  it('refuses a non-http CTA URL', () => {
    expect(() =>
      renderTemplate('verify_email', { FirstName: 'A', Email: 'a@example.com', ExpiresInHours: '24', VerifyUrl: 'javascript:alert(1)' }),
    ).toThrow(/http/);
  });

  it('drops optional fact rows that have no value', () => {
    const out = renderTemplate('password_reset_confirmation', { Email: 'a@example.com', When: 'now' });
    expect(out.html).not.toContain('IP address');
    expect(out.text).not.toContain('IP address');
  });

  it('strips newlines from subjects (header injection)', () => {
    const out = renderTemplate('welcome', { FirstName: 'A\r\nBcc: x@example.com' });
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it('lists placeholders without the global ones', () => {
    const verify = listTemplates().find((t) => t.key === 'verify_email')!;
    expect(verify.placeholders).toEqual(expect.arrayContaining(['FirstName', 'Email', 'VerifyUrl', 'ExpiresInHours']));
    expect(verify.placeholders).not.toContain('AppName');
    expect(placeholdersOf(EMAIL_TEMPLATES.welcome)).toContain('AppName');
  });

  it('samples use example.com only', () => {
    for (const key of KEYS) {
      for (const value of Object.values(EMAIL_TEMPLATES[key].sample)) {
        // A sentence may end right after an address, so the trailing period is not part of it.
        const emails = (value.match(/[\w.+-]+@[\w.-]+/g) ?? []).map((e) => e.replace(/\.$/, ''));
        for (const e of emails) expect(e, `${key}: ${e}`).toMatch(/@example\.com$/);
      }
    }
  });
});

describe('mail provider config', () => {
  it('prefers EMAIL_* keys and builds From from address + name', () => {
    const cfg = resolveMailConfig({
      EMAIL_PROVIDER: 'smtp',
      EMAIL_HOST: 'smtp.example.com',
      EMAIL_PORT: '465',
      EMAIL_USERNAME: 'u',
      EMAIL_PASSWORD: 'p',
      EMAIL_FROM_ADDRESS: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'TradeW',
      SMTP_HOST: 'legacy.example.com',
    });
    expect(cfg.provider).toBe('smtp');
    expect(cfg.smtp).toEqual({ host: 'smtp.example.com', port: 465, user: 'u', pass: 'p' });
    expect(cfg.from).toBe('TradeW <no-reply@example.com>');
  });

  it('falls back to the legacy SMTP_* and MAIL_FROM keys', () => {
    const cfg = resolveMailConfig({ SMTP_HOST: 'h.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'X <x@example.com>' });
    expect(cfg.provider).toBe('smtp');
    expect(cfg.from).toBe('X <x@example.com>');
  });

  it('falls back to console, with a warning, when the requested provider is incomplete', () => {
    const cfg = resolveMailConfig({ EMAIL_PROVIDER: 'smtp', EMAIL_HOST: 'h.example.com' });
    expect(cfg.provider).toBe('console');
    expect(cfg.warning).toMatch(/incomplete/);
  });

  it('keeps SendGrid winning when only its key is present', () => {
    expect(resolveMailConfig({ SENDGRID_API_KEY: 'SG.x', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }).provider).toBe('sendgrid');
  });
});

describe('transient mail errors', () => {
  it('retries network errors, SMTP 4xx and HTTP 429/5xx only', () => {
    expect(isTransientMailError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientMailError({ responseCode: 421 })).toBe(true);
    expect(isTransientMailError({ status: 429 })).toBe(true);
    expect(isTransientMailError({ status: 503 })).toBe(true);
    expect(isTransientMailError({ responseCode: 550 })).toBe(false);
    expect(isTransientMailError({ status: 401 })).toBe(false);
    expect(isTransientMailError(new Error('bad address'))).toBe(false);
  });
});
