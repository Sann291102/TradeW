import { describe, expect, it } from 'vitest';
import { isSecretAcceptable, resolveSecret } from './secret-validation';

/**
 * Pins the boot-time secret policy introduced by the 2026-08-10 assessment.
 *
 * The finding these guard against: JWT_SECRET fell back to the literal
 * 'dev-secret-change-me' and ADMIN_API_TOKEN held a live Anthropic key. Both
 * are "a value that is not actually secret used as an auth boundary." If any of
 * these assertions ever flips, a forbidden value has become acceptable again.
 */

describe('resolveSecret — rejects values that are not real secrets', () => {
  it('throws on an unset value', () => {
    expect(() => resolveSecret('JWT_SECRET', undefined)).toThrow(/not set/i);
    expect(() => resolveSecret('JWT_SECRET', '')).toThrow(/not set/i);
    expect(() => resolveSecret('JWT_SECRET', '   ')).toThrow(/not set/i);
  });

  it('throws on the exact dev placeholder that shipped in app.module.ts and .env', () => {
    expect(() => resolveSecret('JWT_SECRET', 'dev-secret-change-me')).toThrow(/placeholder/i);
  });

  it('throws on other known weak defaults, case-insensitively', () => {
    for (const weak of ['secret', 'CHANGEME', 'Password', 'dev-sentinel-token']) {
      expect(() => resolveSecret('X', weak)).toThrow(/placeholder/i);
    }
  });

  it('throws on a value shorter than the minimum', () => {
    expect(() => resolveSecret('X', 'a'.repeat(31))).toThrow(/characters/i);
    expect(() => resolveSecret('X', 'a'.repeat(32))).not.toThrow();
  });

  it('throws on a reused third-party vendor key (the ADMIN_API_TOKEN = Anthropic finding)', () => {
    const anthropic = 'sk-ant-api03-' + 'a'.repeat(80);
    expect(() => resolveSecret('ADMIN_API_TOKEN', anthropic)).toThrow(/vendor/i);
    // Other vendor prefixes are rejected too.
    expect(() => resolveSecret('X', 'nvapi-' + 'b'.repeat(60))).toThrow(/vendor/i);
    expect(() => resolveSecret('X', 'tvly-' + 'c'.repeat(60))).toThrow(/vendor/i);
  });

  it('allows vendor-prefixed values only when rejectVendorKeys is off (JWT signing key)', () => {
    // A random base64url secret can coincidentally start with "sk-"; the JWT
    // key relies on length + placeholder checks, not the vendor-prefix screen.
    const looksVendorButRandom = 'sk-' + 'Z'.repeat(45);
    expect(() => resolveSecret('JWT_SECRET', looksVendorButRandom, { rejectVendorKeys: false })).not.toThrow();
    expect(() => resolveSecret('ADMIN_API_TOKEN', looksVendorButRandom)).toThrow(/vendor/i);
  });

  it('accepts a strong, dedicated random secret', () => {
    const good = 'Xq9' + 'k7Z2mP'.repeat(9); // 66 chars, no vendor prefix, not a placeholder
    expect(() => resolveSecret('JWT_SECRET', good)).not.toThrow();
    expect(resolveSecret('JWT_SECRET', good)).toBe(good);
  });
});

describe('isSecretAcceptable — the predicate the guards use to fail closed', () => {
  it('is false for the values that were live in .env before the fix', () => {
    expect(isSecretAcceptable('dev-secret-change-me')).toBe(false);
    expect(isSecretAcceptable('sk-ant-api03-' + 'a'.repeat(80), { minLength: 24 })).toBe(false);
    expect(isSecretAcceptable('dev-sentinel-token', { minLength: 24 })).toBe(false);
  });

  it('is true for a strong dedicated secret', () => {
    expect(isSecretAcceptable('a'.repeat(48))).toBe(true);
  });
});
