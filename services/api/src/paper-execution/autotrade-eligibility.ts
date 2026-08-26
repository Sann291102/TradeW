import {
  type ExecutionProfileState,
  STATE_LABELS,
  environmentFor,
  isExecutingState,
  isLiveExecutingState,
} from './execution-state';

/**
 * Who may use Sentinel AutoTrade, and why not.
 *
 * Pure and dependency-free — the fourth decision module in this folder, and for
 * the same reason as the other three: every refusal below is asserted in a unit
 * test rather than reachable only through a database with a subscription, a
 * profile, an arm and a wallet in it.
 *
 * ## §3's rule, stated once
 *
 * "Do not trust a frontend entitlement flag. The backend must enforce
 * eligibility on every relevant endpoint." So this function is the whole
 * definition of eligible, and BOTH the read that decides what the UI renders
 * AND the writes that activate or execute call it. A capability the UI hides
 * but the API honours is not hidden; it is undocumented.
 *
 * ## The six conditions, and why each is separate
 *
 * They are separate because §3 lists them separately and because an operator
 * debugging "why can't this user turn AutoTrade on" needs to know WHICH one
 * failed. A single boolean would answer the question the user asks and none of
 * the questions anyone has to act on.
 */

export interface EligibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface AutoTradeEligibility {
  /** May this account activate/run AutoTrade right now? */
  eligible: boolean;
  /**
   * Should the capability be PRESENTED at all?
   *
   * Deliberately weaker than `eligible`: a Premium subscriber whose profile an
   * administrator has armed should see AutoTrade even while some condition is
   * temporarily unmet (a lapsed broker link, a paused profile), because hiding
   * the control at that moment turns a fixable state into a vanished feature.
   * A user with no entitlement and no armed profile sees nothing — §3.
   */
  visible: boolean;
  /** The user's own switch, as stored. Meaningless when not eligible. */
  autoTradeEnabled: boolean;
  /** Where execution would happen, per the profile's STATE. Null when it would not. */
  environment: 'PAPER' | 'LIVE' | null;
  state: ExecutionProfileState | null;
  checks: EligibilityCheck[];
  /** The first failing check's detail, or null. */
  reason: string | null;
  /** The first failing check's id — the stable, groupable form. */
  failedCheckId: string | null;
}

export interface EligibilityInput {
  /** From EntitlementsService.check(userId, 'sentinel'). */
  hasSentinelEntitlement: boolean;
  entitlementReason: string;

  /** The user's bound execution profile, or null when none exists. */
  profile: {
    id: string;
    name: string;
    state: ExecutionProfileState;
    accountScope: 'SYSTEM_PAPER' | 'USER_PAPER';
    autoTradeEnabled: boolean;
    symbol: string;
    lots: number;
    minConfidence: number;
    maxOpenPositions: number;
    maxOrdersPerDay: number;
    maxLossPerDay: number;
    squareOffMinute: number;
  } | null;

  /** From ExecutionAccountService.authorize — the consent/account/market gate. */
  accountAuthorized: boolean;
  accountReason: string | null;

  /**
   * Broker readiness, needed ONLY when the profile's state is a live one.
   * Absent is fine for paper; a paper profile has no business requiring a
   * brokerage connection, and demanding one would gate the paper loop on the
   * very thing paper exists to avoid.
   */
  broker?: { connected: boolean; expired: boolean } | null;
}

export const AUTOTRADE_CHECK_LABELS: Record<string, string> = {
  'sentinel-premium': 'Sentinel Premium entitlement',
  'profile-exists': 'Sentinel trading profile',
  'admin-armed': 'Administrator arming',
  'account-authorized': 'Account & consent',
  'execution-environment': 'Execution environment',
  'policy-valid': 'Risk policy configuration',
  'broker-connected': 'Broker connection',
};

export function evaluateAutoTradeEligibility(input: EligibilityInput): AutoTradeEligibility {
  const checks: EligibilityCheck[] = [];
  const push = (id: string, passed: boolean, detail: string) =>
    checks.push({ id, label: AUTOTRADE_CHECK_LABELS[id] ?? id, passed, detail });

  // ---- 1. Sentinel Premium -------------------------------------------------
  push(
    'sentinel-premium',
    input.hasSentinelEntitlement,
    input.hasSentinelEntitlement
      ? 'This account holds the Sentinel capability.'
      : `Sentinel Premium is required for AutoTrade (${input.entitlementReason}).`,
  );

  // ---- 2. A profile exists -------------------------------------------------
  const profile = input.profile;
  push(
    'profile-exists',
    profile != null,
    profile
      ? `Bound to execution profile "${profile.name}" on ${profile.symbol}.`
      : 'No Sentinel execution profile is bound to this account. An administrator creates one.',
  );

  if (!profile) {
    // Every remaining check is about the profile. Reporting six failures
    // against a null buries the one line that explains all of them.
    const failed = checks.find((c) => !c.passed)!;
    return {
      eligible: false,
      // Visible only to an entitled account: a free user with no profile must
      // not be shown a capability they cannot reach.
      visible: false,
      autoTradeEnabled: false,
      environment: null,
      state: null,
      checks,
      reason: failed.detail,
      failedCheckId: failed.id,
    };
  }

  // ---- 3. An administrator armed it ---------------------------------------
  //
  // THE CHECK §14 IS ABOUT. Not "is a button visible" — this is the server
  // reading the state machine, and every write path calls the same function.
  const armed = isExecutingState(profile.state);
  push(
    'admin-armed',
    armed,
    armed
      ? `An administrator armed this profile (${STATE_LABELS[profile.state]}).`
      : `This profile is ${STATE_LABELS[profile.state]}. An administrator must arm it before AutoTrade is available.`,
  );

  // ---- 4. Account & consent ------------------------------------------------
  push(
    'account-authorized',
    input.accountAuthorized,
    input.accountAuthorized
      ? 'The bound account is authorized for agent execution.'
      : (input.accountReason ?? 'The bound account is not authorized for agent execution.'),
  );

  // ---- 5. The environment the state implies --------------------------------
  const environment = environmentFor(profile.state);
  push(
    'execution-environment',
    environment != null,
    environment
      ? `Execution would run against the ${environment} engine.`
      : 'This profile’s state resolves to no execution engine.',
  );

  // ---- 6. The risk policy is configured sanely -----------------------------
  //
  // A profile with `maxOrdersPerDay: 0` is not a safe profile, it is a broken
  // one: it would produce a decision every pass and refuse every one, filling
  // the intent table with rejections that look like a policy working. Caught
  // here so it reads as a configuration fault, which is what it is.
  const policyProblems: string[] = [];
  if (!Number.isInteger(profile.lots) || profile.lots < 1) policyProblems.push('lots must be at least 1');
  if (profile.minConfidence < 70 || profile.minConfidence > 100) {
    policyProblems.push('minConfidence must be between 70 and 100');
  }
  if (profile.maxOpenPositions < 1) policyProblems.push('maxOpenPositions must be at least 1');
  if (profile.maxOrdersPerDay < 1) policyProblems.push('maxOrdersPerDay must be at least 1');
  if (!(profile.maxLossPerDay > 0)) policyProblems.push('maxLossPerDay must be positive');
  if (profile.squareOffMinute <= 555 || profile.squareOffMinute > 930) {
    // 555 = 09:15 IST (session open), 930 = 15:30 (close). A square-off outside
    // the session either never fires or fires before the first entry.
    policyProblems.push('squareOffMinute must fall inside the 09:15–15:30 IST session');
  }
  push(
    'policy-valid',
    policyProblems.length === 0,
    policyProblems.length === 0
      ? `${profile.lots} lot(s), ≥${profile.minConfidence}% confidence, ${profile.maxOpenPositions} concurrent, ${profile.maxOrdersPerDay}/day.`
      : `Risk policy is misconfigured: ${policyProblems.join('; ')}.`,
  );

  // ---- 6b. Broker, for live states only ------------------------------------
  if (isLiveExecutingState(profile.state)) {
    const broker = input.broker;
    const ok = broker?.connected === true && broker.expired === false;
    push(
      'broker-connected',
      ok,
      ok
        ? 'A live broker credential is connected and unexpired.'
        : broker?.connected
          ? 'The broker credential has expired. Reconnect before live execution can place an order.'
          : 'No broker credential is connected for this account. Live execution cannot place an order.',
    );
  }

  const failed = checks.find((c) => !c.passed);

  return {
    eligible: !failed,
    // Present the capability to an entitled account whose profile an
    // administrator has armed, even when something else is temporarily wrong —
    // so the user sees the state and its reason rather than an absence.
    visible: input.hasSentinelEntitlement && armed,
    autoTradeEnabled: profile.autoTradeEnabled,
    environment,
    state: profile.state,
    checks,
    reason: failed ? failed.detail : null,
    failedCheckId: failed ? failed.id : null,
  };
}
