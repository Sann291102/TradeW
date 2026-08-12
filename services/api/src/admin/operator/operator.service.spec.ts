import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { OperatorService } from './operator.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The operator identity layer — login, lockout, and the assertion round-trip.
 *
 * Three properties matter enough to pin:
 *  · the assertion is signed with `OPERATOR_JWT_SECRET`, NOT `JWT_SECRET`, so an
 *    operator credential is never a product bearer token (asserted by shape:
 *    `typ: 'operator'` is required on verify);
 *  · revocation is checked against the store on every `verifyAssertion`, so
 *    `disabledAt` denies the NEXT request rather than waiting for expiry;
 *  · repeated wrong passwords lock the account.
 *
 * A hand-rolled in-memory `operatorAccount` store stands in for Prisma — real
 * bcrypt, real JWT, no database. Same shape as the fakes in `broker/`.
 */

const SECRET = 'operator-secret-that-is-comfortably-long-enough-32+';
const OTHER_SECRET = 'a-completely-different-secret-of-sufficient-length';

interface Row {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  disabledAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastSeenAt: Date | null;
  lastLoginIp: string | null;
}

function fakePrisma(rows: Row[]): PrismaService {
  const find = (where: { email?: string; id?: string }) =>
    rows.find((r) => (where.email ? r.email === where.email : r.id === where.id)) ?? null;
  return {
    operatorAccount: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => find(where),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
  } as unknown as PrismaService;
}

async function row(overrides: Partial<Row> & { email: string; password: string }): Promise<Row> {
  const { password, ...rest } = overrides;
  return {
    id: 'op-1',
    name: 'Ops',
    disabledAt: null,
    failedAttempts: 0,
    lockedUntil: null,
    lastSeenAt: null,
    lastLoginIp: null,
    passwordHash: await bcrypt.hash(password, 10),
    ...rest,
  };
}

beforeEach(() => {
  process.env.OPERATOR_JWT_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.OPERATOR_JWT_SECRET;
});

describe('OperatorService.login', () => {
  it('mints an assertion for correct credentials and resets the failure counter', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'correct horse battery' })];
    rows[0].failedAttempts = 3;
    const svc = new OperatorService(fakePrisma(rows));

    const out = await svc.login('op@tradew.io', 'correct horse battery', '10.0.0.1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.operator).toEqual({ id: 'op-1', email: 'op@tradew.io', name: 'Ops' });
    expect(typeof out.result.assertion).toBe('string');
    expect(rows[0].failedAttempts).toBe(0);
    expect(rows[0].lastLoginIp).toBe('10.0.0.1');
  });

  it('is case-insensitive on the email but not the password', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'S3cret-passphrase' })];
    const svc = new OperatorService(fakePrisma(rows));

    await expect(svc.login('OP@TradeW.io', 'S3cret-passphrase', null).then((r) => r.ok)).resolves.toBe(true);
    await expect(svc.login('op@tradew.io', 's3cret-passphrase', null).then((r) => r.ok)).resolves.toBe(false);
  });

  it('denies an unknown account without revealing that it is unknown', async () => {
    const svc = new OperatorService(fakePrisma([]));
    const out = await svc.login('ghost@tradew.io', 'whatever-passphrase', null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('unknown_account');
  });

  it('denies a disabled account even with the right password', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'right-passphrase-1' })];
    rows[0].disabledAt = new Date(0);
    const svc = new OperatorService(fakePrisma(rows));

    const out = await svc.login('op@tradew.io', 'right-passphrase-1', null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('account_disabled');
  });

  it('locks the account after five wrong passwords', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'the-real-passphrase' })];
    const svc = new OperatorService(fakePrisma(rows));

    for (let i = 0; i < 5; i++) await svc.login('op@tradew.io', 'wrong', null);
    expect(rows[0].failedAttempts).toBe(5);
    expect(rows[0].lockedUntil).toBeInstanceOf(Date);

    // Even the CORRECT password is refused while locked.
    const out = await svc.login('op@tradew.io', 'the-real-passphrase', null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('locked_out');
  });

  it('refuses to mint anything when OPERATOR_JWT_SECRET is unset', async () => {
    delete process.env.OPERATOR_JWT_SECRET;
    const rows = [await row({ email: 'op@tradew.io', password: 'right-passphrase-2' })];
    const svc = new OperatorService(fakePrisma(rows));

    expect(svc.enabled()).toBe(false);
    const out = await svc.login('op@tradew.io', 'right-passphrase-2', null);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('disabled_path');
  });
});

describe('OperatorService.verifyAssertion', () => {
  async function mint(rows: Row[]): Promise<string> {
    const svc = new OperatorService(fakePrisma(rows));
    const out = await svc.login(rows[0].email, 'passphrase-for-mint', null);
    if (!out.ok) throw new Error('fixture login failed');
    return out.result.assertion;
  }

  it('accepts a freshly minted assertion and returns the identity', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'passphrase-for-mint' })];
    const assertion = await mint(rows);
    const svc = new OperatorService(fakePrisma(rows));

    const v = await svc.verifyAssertion(assertion);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.operator.id).toBe('op-1');
  });

  it('denies a previously valid assertion once the account is disabled — revocation is a store read', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'passphrase-for-mint' })];
    const assertion = await mint(rows);

    // The account is revoked AFTER the assertion was issued. The assertion is
    // still cryptographically valid; the answer must still become no.
    rows[0].disabledAt = new Date();
    const svc = new OperatorService(fakePrisma(rows));

    const v = await svc.verifyAssertion(assertion);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('account_disabled');
  });

  it('rejects an assertion signed with a different secret', async () => {
    const rows = [await row({ email: 'op@tradew.io', password: 'passphrase-for-mint' })];
    const assertion = await mint(rows);

    // Same account store, but the verifier is configured with another key.
    process.env.OPERATOR_JWT_SECRET = OTHER_SECRET;
    const svc = new OperatorService(fakePrisma(rows));

    const v = await svc.verifyAssertion(assertion);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('invalid_assertion');
  });

  it('rejects a token that is validly signed but not typed as an operator assertion', async () => {
    // A token minted with the operator key but WITHOUT typ:'operator' — the
    // shape a product JWT would have if JWT_SECRET ever equalled this key. It
    // must not authenticate as an operator.
    const { JwtService } = await import('@nestjs/jwt');
    const foreign = new JwtService({ secret: SECRET }).sign({ sub: 'op-1', email: 'op@tradew.io' });
    const rows = [await row({ email: 'op@tradew.io', password: 'passphrase-for-mint' })];
    const svc = new OperatorService(fakePrisma(rows));

    const v = await svc.verifyAssertion(foreign);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('invalid_assertion');
  });
});
