import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_AGENTS,
  DEFAULT_ALLOWED_SYMBOLS,
  type AccountAuthorizationInput,
  authorizeAccount,
} from './execution-account';

/**
 * These assertions are the account boundary.
 *
 * The failure this module exists to prevent is an autonomous agent trading in a
 * real person's account without that person's recorded consent. There are
 * exactly two ways to get there — mislabel a real account as a system one, or
 * mark it USER_PAPER and never ask — and both are pinned below.
 */

const GRANTED = new Date('2026-08-18T04:00:00Z');

/** A dedicated machine account: no password, no Google identity, nobody owns it. */
const SYSTEM_ACCOUNT = {
  id: 'sys-1',
  email: 'sentinel-alpha-nifty@paper.sentinel.tradew.internal',
  hasPasswordCredential: false,
  hasGoogleIdentity: false,
  agentPaperTradingEnabledAt: null,
};

/** A real TradeW user who has granted agent paper trading. */
const USER_ACCOUNT = {
  id: 'user-1',
  email: 'vivek.sannidhi29@gmail.com',
  hasPasswordCredential: true,
  hasGoogleIdentity: false,
  agentPaperTradingEnabledAt: GRANTED,
};

const BASE: AccountAuthorizationInput = {
  environment: 'PAPER',
  declaredScope: 'SYSTEM_PAPER',
  symbol: 'NIFTY',
  agent: 'sentinel-alpha',
  account: SYSTEM_ACCOUNT,
  walletExists: true,
  allowedSymbols: DEFAULT_ALLOWED_SYMBOLS,
  allowedAgents: DEFAULT_ALLOWED_AGENTS,
};

const auth = (over: Partial<AccountAuthorizationInput>) => authorizeAccount({ ...BASE, ...over });
const check = (r: ReturnType<typeof authorizeAccount>, id: string) => r.checks.find((c) => c.id === id)!;

describe('authorizeAccount — SYSTEM_PAPER (the pre-existing mode)', () => {
  it('authorizes a dedicated machine account', () => {
    const r = auth({});
    expect(r.authorized).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('does not require consent for an account no person owns', () => {
    // A system account has no holder, so demanding consent would make the
    // pre-existing mode permanently unusable.
    expect(check(auth({}), 'consent').passed).toBe(true);
    expect(check(auth({}), 'consent').detail).toMatch(/not applicable/i);
  });

  it('REFUSES a real user account labelled SYSTEM_PAPER', () => {
    // Bypass #1: mislabel a real person's account as a machine one and skip the
    // consent check entirely. The scope is an operator's declaration, so it is
    // checked against what the account actually is.
    const r = auth({ account: USER_ACCOUNT });
    expect(r.authorized).toBe(false);
    expect(check(r, 'scope-matches-account').passed).toBe(false);
    expect(r.reason).toMatch(/USER_PAPER/);
  });

  it('refuses a Google-only account labelled SYSTEM_PAPER', () => {
    // Loginable is password OR Google — checking only the password hash would
    // let every Google-signup account through as a "machine" account.
    const r = auth({
      account: { ...SYSTEM_ACCOUNT, hasGoogleIdentity: true },
    });
    expect(r.authorized).toBe(false);
    expect(check(r, 'scope-matches-account').passed).toBe(false);
  });
});

describe('authorizeAccount — USER_PAPER (real TradeW accounts)', () => {
  it('authorizes a real account that granted agent paper trading', () => {
    const r = auth({ declaredScope: 'USER_PAPER', account: USER_ACCOUNT });
    expect(r.authorized).toBe(true);
    expect(check(r, 'consent').passed).toBe(true);
  });

  it('REFUSES a real account that never granted consent', () => {
    // Bypass #2: bind the profile and simply never ask the account holder.
    const r = auth({
      declaredScope: 'USER_PAPER',
      account: { ...USER_ACCOUNT, agentPaperTradingEnabledAt: null },
    });
    expect(r.authorized).toBe(false);
    expect(check(r, 'consent').passed).toBe(false);
    expect(r.reason).toMatch(/has not enabled agent paper trading/);
  });

  it('REFUSES once consent is revoked', () => {
    // Revocation sets the timestamp back to null. Because the flag is re-read
    // every pass rather than cached on the profile, an armed profile stops on
    // the very next tick.
    const granted = auth({ declaredScope: 'USER_PAPER', account: USER_ACCOUNT });
    const revoked = auth({
      declaredScope: 'USER_PAPER',
      account: { ...USER_ACCOUNT, agentPaperTradingEnabledAt: null },
    });
    expect(granted.authorized).toBe(true);
    expect(revoked.authorized).toBe(false);
  });

  it('authorizes a Google-only real account that consented', () => {
    const r = auth({
      declaredScope: 'USER_PAPER',
      account: { ...USER_ACCOUNT, hasPasswordCredential: false, hasGoogleIdentity: true },
    });
    expect(r.authorized).toBe(true);
  });

  it('refuses a machine account labelled USER_PAPER', () => {
    // The mirror of bypass #1: nobody can consent for an account nobody owns,
    // so this binding could never become legitimate.
    const r = auth({ declaredScope: 'USER_PAPER', account: SYSTEM_ACCOUNT });
    expect(r.authorized).toBe(false);
    expect(check(r, 'scope-matches-account').passed).toBe(false);
    expect(r.reason).toMatch(/SYSTEM_PAPER/);
  });
});

describe('authorizeAccount — paper-only and account validity', () => {
  it('refuses any environment that is not PAPER, on either scope', () => {
    for (const declaredScope of ['SYSTEM_PAPER', 'USER_PAPER'] as const) {
      for (const environment of ['LIVE', 'live', 'PROD', '']) {
        const r = auth({ environment, declaredScope, account: declaredScope === 'USER_PAPER' ? USER_ACCOUNT : SYSTEM_ACCOUNT });
        expect(r.authorized).toBe(false);
        expect(check(r, 'environment-paper').passed).toBe(false);
      }
    }
  });

  it('refuses a profile whose account row does not exist', () => {
    const r = auth({ account: null });
    expect(r.authorized).toBe(false);
    expect(check(r, 'account-exists').passed).toBe(false);
  });

  it('does not emit a wall of account checks when the account is missing', () => {
    // Every downstream check would be about a null. Reporting them all as
    // failures buries the one line that explains it.
    const r = auth({ account: null });
    expect(r.checks.some((c) => c.id === 'consent')).toBe(false);
    expect(r.reason).toMatch(/No user row/);
  });

  it('treats a missing paper wallet as fine — the first order creates it', () => {
    // This is exactly what OrderService.ensureWallet does for a human's first
    // trade. Failing here would block a consented account that has never traded.
    const r = auth({ walletExists: false });
    expect(r.authorized).toBe(true);
    expect(check(r, 'paper-wallet').passed).toBe(true);
    expect(check(r, 'paper-wallet').detail).toMatch(/first order creates it/);
  });
});

describe('authorizeAccount — market and agent allowlists', () => {
  it('refuses a market outside the permitted list', () => {
    const r = auth({ symbol: 'RELIANCE' });
    expect(r.authorized).toBe(false);
    expect(check(r, 'market-allowed').passed).toBe(false);
  });

  it('matches the market case-insensitively', () => {
    expect(auth({ symbol: 'nifty' }).authorized).toBe(true);
  });

  it('refuses an agent outside the permitted list', () => {
    const r = auth({ agent: 'rogue-agent' });
    expect(r.authorized).toBe(false);
    expect(check(r, 'agent-allowed').passed).toBe(false);
  });

  it('honours a deployment-specific allowlist', () => {
    expect(auth({ symbol: 'SENSEX', allowedSymbols: ['SENSEX'] }).authorized).toBe(true);
    expect(auth({ symbol: 'NIFTY', allowedSymbols: ['SENSEX'] }).authorized).toBe(false);
  });
});

describe('authorizeAccount — reporting', () => {
  it('runs every check even after one fails, so a refusal is debuggable', () => {
    const r = auth({ declaredScope: 'USER_PAPER', account: { ...USER_ACCOUNT, agentPaperTradingEnabledAt: null }, symbol: 'RELIANCE', agent: 'rogue' });
    expect(r.authorized).toBe(false);
    expect(r.checks.filter((c) => !c.passed).length).toBeGreaterThanOrEqual(3);
  });

  it('never puts a credential in a check detail', () => {
    // The inputs are booleans by construction, but this pins the property that
    // matters: nothing in the human-readable output can leak a secret.
    const r = auth({ declaredScope: 'USER_PAPER', account: USER_ACCOUNT });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/passwordHash|password|hash|googleId|token|secret/i);
  });
});
