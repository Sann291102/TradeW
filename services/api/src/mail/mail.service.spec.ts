import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailService, parseMailFrom } from './mail.service';

/**
 * The mailer's provider selection and, more importantly, its disclosure
 * contract.
 *
 * `preview` is the single signal that says "this message was never handed to a
 * provider", and `OtpService` discloses a live credential in an HTTP response
 * on the strength of it. So the tests that matter here are not "does SendGrid
 * get called" but "is `preview` ever set when a provider was involved" — the
 * property that, when it was assumed rather than tested, let a provider outage
 * turn `POST /auth/otp/request` into an OTP oracle.
 */

const MAIL_ENV = ['SENDGRID_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'] as const;

describe('MailService', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of MAIL_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of MAIL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  describe('console mode — no provider configured', () => {
    it('does not deliver, and returns the body as preview', async () => {
      const res = await new MailService().send('u@example.com', 'Subject', 'code 123456');
      expect(res.delivered).toBe(false);
      expect(res.preview).toBe('code 123456');
    });

    it('makes no network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await new MailService().send('u@example.com', 'Subject', 'body');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('sendgrid mode', () => {
    beforeEach(() => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      process.env.MAIL_FROM = 'TradeW · Setup <admin@tradew-setup.com>';
    });

    it('POSTs to the v3 API with a bearer key and the parsed sender', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => '' });
      vi.stubGlobal('fetch', fetchSpy);

      const res = await new MailService().send('u@example.com', 'Your code', 'code 123456', '<p>123456</p>');

      expect(res.delivered).toBe(true);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
      expect(init.headers.Authorization).toBe('Bearer SG.test-key');

      const body = JSON.parse(init.body);
      expect(body.personalizations).toEqual([{ to: [{ email: 'u@example.com' }] }]);
      expect(body.from).toEqual({ email: 'admin@tradew-setup.com', name: 'TradeW · Setup' });
      // SendGrid requires ascending MIME preference — plain text first.
      expect(body.content.map((c: { type: string }) => c.type)).toEqual(['text/plain', 'text/html']);
    });

    it('omits the html part when there is none, rather than sending an empty one', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => '' });
      vi.stubGlobal('fetch', fetchSpy);

      await new MailService().send('u@example.com', 'Subject', 'text only');

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.content).toHaveLength(1);
      expect(body.content[0].type).toBe('text/plain');
    });

    it('NEVER returns a preview when the provider rejects the send', async () => {
      // The regression that matters: a 429 at the free-tier cap, or a 401 on a
      // rotated key, must not look like "unconfigured" to the caller. If this
      // ever returns a preview, OtpService puts the live code in an HTTP
      // response on a production server.
      const fetchSpy = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 429, text: async () => '{"errors":[{"message":"maximum credits exceeded"}]}' });
      vi.stubGlobal('fetch', fetchSpy);

      const res = await new MailService().send('u@example.com', 'Your code', 'code 123456');

      expect(res.delivered).toBe(false);
      expect(res.preview).toBeUndefined();
    });

    it('NEVER returns a preview when the request itself throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));

      const res = await new MailService().send('u@example.com', 'Your code', 'code 123456');

      expect(res.delivered).toBe(false);
      expect(res.preview).toBeUndefined();
    });

    it('does not propagate provider failures — a bad key is not a 500', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }));
      await expect(new MailService().send('u@example.com', 'S', 'body')).resolves.toBeDefined();
    });

    it('is preferred over SMTP when both are configured', async () => {
      process.env.SMTP_HOST = 'smtp.gmail.com';
      process.env.SMTP_USER = 'someone@gmail.com';
      process.env.SMTP_PASS = 'app-password';
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => '' });
      vi.stubGlobal('fetch', fetchSpy);

      await new MailService().send('u@example.com', 'S', 'body');

      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });
});

describe('parseMailFrom', () => {
  it('splits RFC 5322 form into name and address', () => {
    expect(parseMailFrom('TradeW · Setup <admin@tradew-setup.com>')).toEqual({
      name: 'TradeW · Setup',
      email: 'admin@tradew-setup.com',
    });
  });

  it('accepts a bare address', () => {
    expect(parseMailFrom('admin@tradew-setup.com')).toEqual({ email: 'admin@tradew-setup.com' });
  });

  it('strips surrounding quotes from a display name', () => {
    expect(parseMailFrom('"TradeW, Setup" <a@b.com>')).toEqual({ name: 'TradeW, Setup', email: 'a@b.com' });
  });

  it('omits the name rather than sending an empty one', () => {
    expect(parseMailFrom('<a@b.com>')).toEqual({ email: 'a@b.com' });
  });

  it('trims incidental whitespace', () => {
    expect(parseMailFrom('  TradeW  <  a@b.com  >  ')).toEqual({ name: 'TradeW', email: 'a@b.com' });
  });
});
