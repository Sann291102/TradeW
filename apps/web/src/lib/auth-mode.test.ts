import { describe, expect, it } from 'vitest';
import { AUTH_COPY, readAuthMode } from './auth-mode';
import { describeApiFailure } from './api';

/**
 * The auth screen used to say two different things at once: the heading offered
 * to create an account while the form under it was a sign-in, submit button and
 * all. The state that decides both now lives in one place, and these are the
 * two halves of that fix worth pinning — the copy pairs, and the URL parsing
 * that decides which pair a visitor lands on.
 */
describe('auth mode copy', () => {
  it('says "create" for signup and "sign in" for login', () => {
    expect(AUTH_COPY.signup.heading).toMatch(/create/i);
    expect(AUTH_COPY.login.heading).toMatch(/sign in/i);
  });

  it('never offers account creation in the sign-in copy', () => {
    expect(AUTH_COPY.login.heading).not.toMatch(/create/i);
    expect(`${AUTH_COPY.login.sub}`).not.toMatch(/create your/i);
  });
});

describe('readAuthMode', () => {
  it('reads the query parameter the /signup redirect uses', () => {
    expect(readAuthMode('?auth=signup', '#auth')).toBe('signup');
    expect(readAuthMode('?auth=login', '')).toBe('login');
  });

  it('accepts the fragment forms', () => {
    expect(readAuthMode('', '#auth?auth=signup')).toBe('signup');
    expect(readAuthMode('', '#auth=signup')).toBe('signup');
  });

  it('accepts the common aliases', () => {
    expect(readAuthMode('?auth=register', '')).toBe('signup');
    expect(readAuthMode('?auth=signin', '')).toBe('login');
  });

  it('expresses no preference for a plain anchor or an unknown value', () => {
    // The caller's default must win here rather than a guess: `#auth` is what
    // every in-page CTA links to, and those set the mode themselves.
    expect(readAuthMode('', '#auth')).toBeNull();
    expect(readAuthMode('?auth=whatever', '#auth')).toBeNull();
    expect(readAuthMode('', '')).toBeNull();
  });

  it('lets the query win over the fragment', () => {
    expect(readAuthMode('?auth=signup', '#auth=login')).toBe('signup');
  });
});

/**
 * Every failing call used to reach the user as the four words "API request
 * failed" — the same sentence for a wrong password, a mistyped API base URL
 * and a proxy's HTML error page. These assert that a failure describes itself.
 */
describe('describeApiFailure', () => {
  it('prefers the server’s own message', () => {
    expect(describeApiFailure(401, 'Unauthorized', '/auth/login', { message: 'Invalid credentials' })).toBe(
      'Invalid credentials',
    );
  });

  it('joins the constraint list ValidationPipe returns', () => {
    const message = describeApiFailure(400, 'Bad Request', '/auth/signup', {
      message: ['email must be an email', 'password must be longer than 8 characters'],
      error: 'Bad Request',
    });
    expect(message).toBe('email must be an email. password must be longer than 8 characters');
  });

  it('falls back to the error field', () => {
    expect(describeApiFailure(403, 'Forbidden', '/auth/login', { error: 'Forbidden' })).toBe('Forbidden');
  });

  it('describes the response when the body carries nothing usable', () => {
    // A proxy's HTML error page parses to {} — the old code called that "API
    // request failed" and threw away the only facts available.
    const message = describeApiFailure(502, 'Bad Gateway', '/auth/login', {});
    expect(message).toContain('502');
    expect(message).toContain('Bad Gateway');
    expect(message).toContain('/auth/login');
    expect(message).not.toBe('API request failed');
  });

  it('survives a null body and a missing reason phrase', () => {
    expect(describeApiFailure(500, '', '/auth/login', null)).toBe('/auth/login failed with 500');
  });

  it('ignores a blank message rather than showing an empty alert', () => {
    expect(describeApiFailure(404, 'Not Found', '/auth/login', { message: '   ' })).toContain('404');
  });
});
