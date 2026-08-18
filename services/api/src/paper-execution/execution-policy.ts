/**
 * The risk and discipline checks an execution intent must clear before it may
 * reach `OrderService`.
 *
 * Pure and dependency-free so every rule can be asserted without a database or
 * a Nest context — the same reason `sim/order.service.ts` keeps `applyFill`
 * pure. The caller gathers the live facts; this decides.
 *
 * ## This is a SECOND gate, never a replacement
 *
 * Sentinel's own four-condition publication gate already decided whether a
 * directional read exists at all, and `StrategyAdvisorService.sideInFocus`
 * already refuses to produce one below 70% confidence or on a neutral bias.
 * Nothing here can loosen either. Every check below can only subtract.
 *
 * ## And it is not the last gate
 *
 * `OrderService.placeOrder` still applies lot-size validation, simulated margin
 * and the trader-discipline limits to whatever this admits. An intent that
 * passes here can still be rejected there, and that is correct: this layer
 * governs whether the DECISION should be acted on, the OMS governs whether the
 * ORDER can be filled. Collapsing the two would put risk policy in the order
 * book and order mechanics in the strategy layer.
 */

export interface PolicyCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface PolicyDecision {
  allowed: boolean;
  checks: PolicyCheck[];
  /** The first failing check's detail, or null when allowed. */
  reason: string | null;
}

export interface PolicyInput {
  /** From ExecutionProfile. */
  enabled: boolean;
  environment: string;
  minConfidence: number;
  maxOpenPositions: number;
  maxOrdersPerDay: number;
  /** Positive number; compared against a negative realized P&L. */
  maxLossPerDay: number;
  squareOffMinute: number;

  /** Live facts the caller gathered. */
  confidence: number;
  openPositions: number;
  ordersToday: number;
  realizedPnlToday: number;
  /** IST minute-of-day at decision time. */
  minuteOfDay: number;
  marketOpen: boolean;
  /** Cash the paper wallet can actually block. */
  availableCash: number;
  /** Premium × quantity for a long option — the full cost and the full risk. */
  estimatedCost: number;
}

/** IST minute-of-day the Indian equity session opens (09:15). */
export const SESSION_OPEN_MINUTE = 9 * 60 + 15;

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const checks: PolicyCheck[] = [];

  const push = (id: string, label: string, passed: boolean, detail: string) =>
    checks.push({ id, label, passed, detail });

  push(
    'profile-enabled',
    'Profile enabled',
    input.enabled,
    input.enabled ? 'Profile is enabled for execution.' : 'Profile is disabled; no order may be produced.',
  );

  // THE ENVIRONMENT CHECK IS NOT DECORATIVE. `ExecutionEnvironment` has exactly
  // one member, so a non-PAPER value here means the row was written by
  // something other than this application (a direct SQL edit, a restore from a
  // future schema). Refusing it costs nothing and is the difference between
  // "live money is unrepresentable" and "live money is unrepresentable unless
  // someone gets a row past Prisma".
  const isPaper = input.environment === 'PAPER';
  push(
    'environment-paper',
    'Environment is PAPER',
    isPaper,
    isPaper ? 'Executing against the paper engine.' : `Refused: environment is "${input.environment}", not PAPER.`,
  );

  push(
    'market-open',
    'Market open',
    input.marketOpen,
    input.marketOpen ? 'The session is open.' : 'The market is closed; no entry is taken outside the session.',
  );

  // Entering a position minutes before the profile's own square-off would open
  // something the loop is about to close, booking two sets of charges to learn
  // nothing.
  const beforeSquareOff = input.minuteOfDay < input.squareOffMinute;
  push(
    'before-square-off',
    'Before square-off',
    beforeSquareOff,
    beforeSquareOff
      ? `${formatIstMinute(input.minuteOfDay)} is before the ${formatIstMinute(input.squareOffMinute)} square-off.`
      : `${formatIstMinute(input.minuteOfDay)} is at or past the ${formatIstMinute(input.squareOffMinute)} square-off; entries are closed for the day.`,
  );

  const confidenceOk = input.confidence >= input.minConfidence;
  push(
    'confidence-floor',
    'Confidence floor',
    confidenceOk,
    `${input.confidence}% against this profile's ${input.minConfidence}% floor.`,
  );

  const positionsOk = input.openPositions < input.maxOpenPositions;
  push(
    'max-open-positions',
    'Open position limit',
    positionsOk,
    `${input.openPositions} open against a ${input.maxOpenPositions} limit.`,
  );

  const ordersOk = input.ordersToday < input.maxOrdersPerDay;
  push(
    'max-orders-per-day',
    'Daily order limit',
    ordersOk,
    `${input.ordersToday} placed today against a ${input.maxOrdersPerDay} limit.`,
  );

  // Compared as a signed number against a negative bound, deliberately: writing
  // this as `Math.abs(pnl) < max` would stop the loop after a good day too.
  const lossOk = input.realizedPnlToday > -Math.abs(input.maxLossPerDay);
  push(
    'daily-loss-limit',
    'Daily loss limit',
    lossOk,
    lossOk
      ? `Realized ${formatInr(input.realizedPnlToday)} today, inside the ${formatInr(-Math.abs(input.maxLossPerDay))} floor.`
      : `Realized ${formatInr(input.realizedPnlToday)} today, at or past the ${formatInr(-Math.abs(input.maxLossPerDay))} floor. Trading is stopped for the day.`,
  );

  // A soft pre-check only. `OrderService` computes the authoritative simulated
  // margin and rejects on it; this exists so an obviously unaffordable intent
  // is refused as a POLICY decision with an explanation, rather than becoming a
  // REJECTED order row that looks like an OMS fault in the console.
  const affordable = input.estimatedCost <= input.availableCash;
  push(
    'affordable',
    'Sufficient paper capital',
    affordable,
    `Estimated ${formatInr(input.estimatedCost)} against ${formatInr(input.availableCash)} available.`,
  );

  const failed = checks.find((c) => !c.passed);
  return { allowed: !failed, checks, reason: failed ? failed.detail : null };
}

function formatIstMinute(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function formatInr(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}
