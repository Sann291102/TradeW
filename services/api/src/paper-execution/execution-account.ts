/**
 * Who an execution profile is allowed to trade for.
 *
 * Pure and dependency-free, like `execution-policy.ts` — the caller reads the
 * account, this decides. That split is what lets every refusal below be
 * asserted without a database, and it keeps the rule in one readable place
 * instead of scattered across `runProfile`.
 *
 * ## The two bypasses this exists to close
 *
 * `ExecutionProfile.accountScope` is a DECLARATION written by an operator, not
 * a permission. Trusting it would leave two ways to trade a real person's money
 * without their consent:
 *
 *   1. Point a profile marked SYSTEM_PAPER at a real user's account. It would
 *      look like a machine account in the console and never hit the consent
 *      check. So SYSTEM_PAPER additionally requires the account to be
 *      structurally NON-LOGINABLE — no password hash, no Google identity. A
 *      real person's account can never pass as a system one.
 *
 *   2. Mark a profile USER_PAPER and simply not ask the user. So USER_PAPER
 *      requires `User.agentPaperTradingEnabledAt` to be set, re-read on every
 *      pass rather than cached on the profile — a grant that outlives its
 *      revocation is not a grant.
 *
 * Together: the scope must match what the account actually IS, and a real
 * account must additionally have said yes.
 *
 * ## What this deliberately does not check
 *
 * There is no `User.disabledAt` in this schema — account deactivation is not a
 * concept the platform models today — so "account is active" reduces to "the
 * row exists". Inventing a disabled flag here would be a platform change
 * smuggled in through a feature, and a column nothing else honours is worse
 * than no column. Flagged rather than faked.
 */

export interface AccountCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface AccountAuthorization {
  authorized: boolean;
  checks: AccountCheck[];
  /** The first failing check's detail, or null when authorized. */
  reason: string | null;
}

export type AccountScope = 'SYSTEM_PAPER' | 'USER_PAPER';

export interface AccountAuthorizationInput {
  /** From the profile. */
  environment: string;
  declaredScope: AccountScope;
  symbol: string;
  agent: string;

  /** From the account row. Null when no such user exists. */
  account: {
    id: string;
    email: string;
    /** Presence of EITHER means a person can sign in to this account. */
    hasPasswordCredential: boolean;
    hasGoogleIdentity: boolean;
    /** `User.agentPaperTradingEnabledAt`. Null = never granted, or revoked. */
    agentPaperTradingEnabledAt: Date | null;
  } | null;

  /** Whether a PaperWallet row already exists for the account. */
  walletExists: boolean;

  /** Markets and agents this deployment permits. */
  allowedSymbols: string[];
  allowedAgents: string[];
}

/**
 * Markets an agent may trade, by default.
 *
 * An allowlist rather than a blocklist: a symbol nobody has thought about
 * should be unreachable, not reachable. Index options only — the three-strike
 * evaluator assumes a listed strike ladder, which a single stock's chain may
 * not have.
 *
 * SENSEX and BANKEX joined the list on 2026-08-30, with the autonomous SENSEX
 * agent. They are BSE indices, so their options are `BSE_FNO` rather than
 * `NSE_FNO` — the live-feed bridge resolves the segment from the scrip-master
 * row rather than assuming it (a hardcoded `NSE_FNO` had previously dropped
 * every SENSEX option tick), and `strike-candidates.ts` already carries their
 * 100-point strike intervals. Adding a market here is a deliberate act: it is
 * the list that decides which chains an autonomous agent may price a contract
 * from.
 */
export const DEFAULT_ALLOWED_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

/** Agent identities permitted to execute. Same reasoning as the symbol list. */
export const DEFAULT_ALLOWED_AGENTS = ['sentinel-alpha', 'sentinel-beta', 'sentinel-gamma'];

export function authorizeAccount(input: AccountAuthorizationInput): AccountAuthorization {
  const checks: AccountCheck[] = [];
  const push = (id: string, label: string, passed: boolean, detail: string) =>
    checks.push({ id, label, passed, detail });

  const isPaper = input.environment === 'PAPER';
  push(
    'environment-paper',
    'Environment is PAPER',
    isPaper,
    isPaper
      ? 'Paper environment — the live broker path is unreachable from here.'
      : `Refused: environment is "${input.environment}", not PAPER.`,
  );

  const account = input.account;
  push(
    'account-exists',
    'Account exists',
    account != null,
    account ? `${account.email} (${account.id})` : 'No user row for this profile’s accountUserId.',
  );

  if (!account) {
    // Every remaining check is about the account. Reporting them as failures
    // against a null would produce a wall of noise whose real cause is one line
    // above it.
    return { authorized: false, checks, reason: checks.find((c) => !c.passed)!.detail };
  }

  const loginable = account.hasPasswordCredential || account.hasGoogleIdentity;

  if (input.declaredScope === 'SYSTEM_PAPER') {
    // Bypass #1. A profile cannot call a real person's account a system one.
    push(
      'scope-matches-account',
      'SYSTEM_PAPER account is not loginable',
      !loginable,
      loginable
        ? `Refused: ${account.email} has a sign-in credential, so it is a real user account. ` +
          'Bind it as USER_PAPER and record the account holder’s consent instead.'
        : `${account.email} has no password and no Google identity — a dedicated machine account.`,
    );
    // Consent is meaningless for an account no person owns, so it is not
    // required here. Saying so explicitly keeps the check list readable
    // side-by-side with the USER_PAPER case.
    push('consent', 'Account-holder consent', true, 'Not applicable — no person owns a system paper account.');
  } else {
    // Bypass #2. A real account must have said yes, and still be saying yes.
    push(
      'scope-matches-account',
      'USER_PAPER account is a real TradeW account',
      loginable,
      loginable
        ? `${account.email} is a real TradeW account.`
        : `Refused: ${account.email} has no sign-in credential, so no person owns it. ` +
          'Bind it as SYSTEM_PAPER instead.',
    );
    const consented = account.agentPaperTradingEnabledAt != null;
    push(
      'consent',
      'Account-holder consent',
      consented,
      consented
        ? `Agent paper trading enabled for ${account.email} on ${account.agentPaperTradingEnabledAt!.toISOString()}.`
        : `Refused: ${account.email} has not enabled agent paper trading. ` +
          'An operator must grant it explicitly before an agent may trade this account.',
    );
  }

  // Not a hard failure to be missing — `OrderService.ensureWallet` creates one
  // on the first order with the standard starting balance, exactly as it does
  // for a human's first trade. Reported so the console can show it.
  push(
    'paper-wallet',
    'Paper wallet',
    true,
    input.walletExists
      ? 'Existing paper wallet — the same one the user trades manually.'
      : 'No wallet yet; the first order creates it with the standard paper balance.',
  );

  const symbolOk = input.allowedSymbols.includes(input.symbol.toUpperCase());
  push(
    'market-allowed',
    'Market allowed',
    symbolOk,
    symbolOk
      ? `${input.symbol} is in the permitted market list.`
      : `Refused: ${input.symbol} is not in the permitted market list (${input.allowedSymbols.join(', ')}).`,
  );

  const agentOk = input.allowedAgents.includes(input.agent);
  push(
    'agent-allowed',
    'Agent allowed',
    agentOk,
    agentOk
      ? `${input.agent} is a permitted execution agent.`
      : `Refused: ${input.agent} is not a permitted execution agent (${input.allowedAgents.join(', ')}).`,
  );

  const failed = checks.find((c) => !c.passed);
  return { authorized: !failed, checks, reason: failed ? failed.detail : null };
}
