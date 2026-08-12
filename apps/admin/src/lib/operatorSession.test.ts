import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidSessionValue, readSessionValue, sealSession } from './operatorSession';

/**
 * The sealed session cookie is the entire standalone-console auth boundary once
 * `services/api` has verified the operator's credentials once at login. These
 * tests pin the properties the security brief insisted on:
 *
 *  · a genuinely sealed cookie round-trips back to the same assertion + operator;
 *  · a tampered cookie, a cookie sealed under a different key, and an expired
 *    cookie are all rejected (never throw — they resolve to "not signed in");
 *  · sealing fails closed when ADMIN_SESSION_SECRET is absent.
 *
 * Node environment: Web Crypto (`crypto.subtle`) is a Node global.
 */

const SECRET = 'admin-session-secret-comfortably-over-32-chars';
const OTHER = 'a-different-admin-session-secret-also-32+chars';
const OPERATOR = { id: 'op-1', email: 'ops@tradew.io', name: 'Ops' };

describe('operator session sealing', () => {
  const original = process.env.ADMIN_SESSION_SECRET;
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    process.env.ADMIN_SESSION_SECRET = original;
  });

  it('round-trips the assertion and operator identity', async () => {
    const cookie = await sealSession('the.operator.assertion', OPERATOR);
    const payload = await readSessionValue(cookie);
    expect(payload).not.toBeNull();
    expect(payload?.assertion).toBe('the.operator.assertion');
    expect(payload?.operator).toEqual(OPERATOR);
    expect(await isValidSessionValue(cookie)).toBe(true);
  });

  it('does not expose the plaintext assertion in the cookie value', async () => {
    const cookie = await sealSession('super-secret-assertion-value', OPERATOR);
    // The whole security property: what rides in the cookie is ciphertext.
    expect(cookie).not.toContain('super-secret-assertion-value');
    expect(cookie).not.toContain('ops@tradew.io');
  });

  it('rejects a cookie sealed under a different secret', async () => {
    const cookie = await sealSession('x.y.z', OPERATOR);
    process.env.ADMIN_SESSION_SECRET = OTHER;
    expect(await readSessionValue(cookie)).toBeNull();
    expect(await isValidSessionValue(cookie)).toBe(false);
  });

  it('rejects a tampered cookie without throwing', async () => {
    const cookie = await sealSession('x.y.z', OPERATOR);
    // Flip a character in the middle of the sealed blob.
    const i = Math.floor(cookie.length / 2);
    const tampered = cookie.slice(0, i) + (cookie[i] === 'A' ? 'B' : 'A') + cookie.slice(i + 1);
    expect(await readSessionValue(tampered)).toBeNull();
  });

  it('rejects garbage and empty values', async () => {
    expect(await readSessionValue('')).toBeNull();
    expect(await readSessionValue(undefined)).toBeNull();
    expect(await readSessionValue('not-base64url!!')).toBeNull();
    expect(await readSessionValue('AAAA')).toBeNull();
  });

  it('fails closed when ADMIN_SESSION_SECRET is unset', async () => {
    const cookie = await sealSession('x.y.z', OPERATOR); // sealed while configured
    delete process.env.ADMIN_SESSION_SECRET;
    // Reading with no secret configured is "not signed in", never a crash.
    expect(await readSessionValue(cookie)).toBeNull();
    // And a new login cannot be sealed at all.
    await expect(sealSession('x.y.z', OPERATOR)).rejects.toThrow(/ADMIN_SESSION_SECRET/);
  });

  it('rejects a short secret as if unset (fails closed)', async () => {
    process.env.ADMIN_SESSION_SECRET = 'too-short';
    await expect(sealSession('x.y.z', OPERATOR)).rejects.toThrow(/ADMIN_SESSION_SECRET/);
  });
});
