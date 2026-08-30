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

import { PLATFORM_CONFIDENCE_FLOOR, applyCalibration } from './execution-calibration';

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
  /**
   * The first failing check's ID, or null when allowed.
   *
   * `reason` is a sentence with live numbers interpolated into it, so no two
   * refusals are ever the same string and the column it is stored in cannot be
   * grouped. This is the same refusal in a form that can be counted — it is
   * what `ExecutionIntent.rejectCheckId` records and what the console's
   * "why did nothing trade today?" breakdown groups by.
   */
  failedCheckId: string | null;
  /**
   * The confidence floor this decision was actually held to, after the
   * profile's own number and the bucket's learned adjustment, clamped at the
   * platform's 70. Recorded on the intent so a past refusal can be read
   * without recomputing what the calibration was at the time.
   */
  effectiveConfidenceFloor: number;
}

/**
 * Every id an intent's refusal can carry, and how to say it to a person.
 *
 * ONE map, used both to label a live check and to label a stored refusal
 * counted days later. Two lists would drift the moment a check is renamed, and
 * the drift would show up as an unlabelled bar on the console rather than as a
 * failure anyone notices.
 *
 * The last two are not policy checks: they are the ways an intent that PASSED
 * policy still never became a position. They belong here because the question
 * the console asks — "why did nothing trade?" — does not distinguish them.
 */
export const REJECT_CHECK_LABELS: Record<string, string> = {
  'profile-enabled': 'Profile enabled',
  'environment-paper': 'Environment is PAPER',
  'market-open': 'Market open',
  'before-square-off': 'Before square-off',
  'confidence-floor': 'Confidence floor',
  'max-open-positions': 'Open position limit',
  'max-orders-per-day': 'Daily order limit',
  'daily-loss-limit': 'Daily loss limit',
  affordable: 'Sufficient paper capital',
  'submission-raised': 'Submission raised',
  'oms-rejected': 'Rejected by the OMS',
  // ---- Autonomous agents (2026-08-30) ----
  'quote-freshness': 'Live quote is current',
  'index-direction': 'Index direction agrees',
  'risk-plan': 'Risk plan is sizeable',
  'allocation-ceiling': 'Capital allocation',
  'risk-budget': 'Risk budget',
  // Every refusal Sentinel itself produced, so the console's "why did nothing
  // trade today?" breakdown can group them beside this layer's own. Without
  // these the largest bar on that chart is an unlabelled id.
  'sentinel-stale-data': 'Sentinel: data too stale',
  'sentinel-no-agent-strategy': 'Sentinel: no agent strategy validated',
  'sentinel-index-direction-conflict': 'Sentinel: index disagreed with the side',
  'sentinel-evidence-conflict': 'Sentinel: strategy evidence did not support',
};

/** The two non-policy stops, named so a caller cannot misspell one. */
export const SUBMISSION_RAISED = 'submission-raised';
export const OMS_REJECTED = 'oms-rejected';

/** How to say a check id to a person; the id itself if it is not a known one. */
export function rejectCheckLabel(id: string | null): string {
  if (!id) return 'Not recorded';
  return REJECT_CHECK_LABELS[id] ?? id;
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

  // ---- Autonomous agents (2026-08-30) ------------------------------------
  /**
   * Whether the live feed is actually ticking, from `assessFreshness`.
   *
   * SEPARATE from `marketOpen`. The venue being open and the feed delivering
   * are different facts, and the 2026-08-17 incident is what it looks like
   * when only the first is checked: the bridge answered every request while
   * serving a tick map that had stopped advancing hours earlier.
   */
  quoteFresh: boolean;
  quoteFreshnessDetail: string;

  /**
   * The index's own direction, and the option side being taken.
   *
   * Sentinel has already refused a mismatch; this is the SECOND, independent
   * check of the same thing on this side of the network hop, for the same
   * reason `environment-paper` is checked twice. A response that arrived
   * saying `executable` with a conflicting direction did not come from the
   * Sentinel this deployment thinks it is talking to.
   */
  indexDirection: string;
  optionSide: 'CE' | 'PE';

  /**
   * The floor adjustment this (agent, symbol, strategy, version, regime)
   * bucket has earned from its own completed trades, in whole confidence
   * points. Positive raises the bar. See `execution-calibration.ts`.
   */
  calibrationAdjustment: number;

  /** Did `planRisk` produce a sizeable position, and if not, why not. */
  riskPlanOk: boolean;
  riskPlanReason: string | null;
  riskPlanCheckId: string | null;
}

/** IST minute-of-day the Indian equity session opens (09:15). */
export const SESSION_OPEN_MINUTE = 9 * 60 + 15;

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const checks: PolicyCheck[] = [];

  // The label is looked up, never passed in: a check's display name lives in
  // exactly one place, so renaming one cannot leave the stored-refusal
  // breakdown showing the old wording.
  const push = (id: string, passed: boolean, detail: string) =>
    checks.push({ id, label: rejectCheckLabel(id), passed, detail });

  push(
    'profile-enabled',
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
    isPaper,
    isPaper ? 'Executing against the paper engine.' : `Refused: environment is "${input.environment}", not PAPER.`,
  );

  push(
    'market-open',
    input.marketOpen,
    input.marketOpen ? 'The session is open.' : 'The market is closed; no entry is taken outside the session.',
  );

  // Entering a position minutes before the profile's own square-off would open
  // something the loop is about to close, booking two sets of charges to learn
  // nothing.
  const beforeSquareOff = input.minuteOfDay < input.squareOffMinute;
  push(
    'before-square-off',
    beforeSquareOff,
    beforeSquareOff
      ? `${formatIstMinute(input.minuteOfDay)} is before the ${formatIstMinute(input.squareOffMinute)} square-off.`
      : `${formatIstMinute(input.minuteOfDay)} is at or past the ${formatIstMinute(input.squareOffMinute)} square-off; entries are closed for the day.`,
  );

  // ---- THE FEED IS TICKING, not merely reachable -------------------------
  push('quote-freshness', input.quoteFresh, input.quoteFreshnessDetail);

  // ---- The index and the option side agree -------------------------------
  //
  // Sentinel refused this already. Checked again HERE because the two checks
  // are on opposite sides of a network hop, and this side must not take a
  // remote service's word for the one property that decides which direction
  // real money would be committed in. Exactly the reasoning behind checking
  // `environment-paper` twice.
  const permittedSide = input.indexDirection === 'bullish' ? 'CE' : input.indexDirection === 'bearish' ? 'PE' : null;
  const directionOk = permittedSide === input.optionSide;
  push(
    'index-direction',
    directionOk,
    directionOk
      ? `The index reads ${input.indexDirection}, which is the ${input.optionSide} side.`
      : `Refused: the index reads ${input.indexDirection}, which permits ${permittedSide ?? 'no side'}, but the decision is ${input.optionSide}.`,
  );

  // ---- The CALIBRATED confidence floor -----------------------------------
  //
  // `applyCalibration` clamps at the platform's own 70 whatever the profile
  // asked for and whatever the bucket learned, so a stored calibration can
  // make this bucket HARDER to trade and can never make it easier than the
  // platform bar. See `execution-calibration.ts`.
  const effectiveFloor = applyCalibration(input.minConfidence, input.calibrationAdjustment);
  const confidenceOk = input.confidence >= effectiveFloor;
  push(
    'confidence-floor',
    confidenceOk,
    input.calibrationAdjustment === 0
      ? `${input.confidence}% against this profile's ${input.minConfidence}% floor.`
      : `${input.confidence}% against an effective ${effectiveFloor}% floor — this profile's ${input.minConfidence}% ` +
        `${input.calibrationAdjustment > 0 ? 'raised' : 'lowered'} by ${Math.abs(input.calibrationAdjustment)} point(s) of learned calibration ` +
        `(never below the platform's ${PLATFORM_CONFIDENCE_FLOOR}%).`,
  );

  const positionsOk = input.openPositions < input.maxOpenPositions;
  push(
    'max-open-positions',
    positionsOk,
    `${input.openPositions} open against a ${input.maxOpenPositions} limit.`,
  );

  const ordersOk = input.ordersToday < input.maxOrdersPerDay;
  push(
    'max-orders-per-day',
    ordersOk,
    `${input.ordersToday} placed today against a ${input.maxOrdersPerDay} limit.`,
  );

  // Compared as a signed number against a negative bound, deliberately: writing
  // this as `Math.abs(pnl) < max` would stop the loop after a good day too.
  const lossOk = input.realizedPnlToday > -Math.abs(input.maxLossPerDay);
  push(
    'daily-loss-limit',
    lossOk,
    lossOk
      ? `Realized ${formatInr(input.realizedPnlToday)} today, inside the ${formatInr(-Math.abs(input.maxLossPerDay))} floor.`
      : `Realized ${formatInr(input.realizedPnlToday)} today, at or past the ${formatInr(-Math.abs(input.maxLossPerDay))} floor. Trading is stopped for the day.`,
  );

  // ---- A sizeable position could actually be planned ---------------------
  //
  // `planRisk` refuses when one lot does not fit inside the allocation ceiling
  // or the risk budget. That is a POLICY refusal with an explanation, not an
  // error — and it is checked here so it lands in the rejection breakdown
  // beside every other reason nothing traded.
  push(
    input.riskPlanCheckId ?? 'risk-plan',
    input.riskPlanOk,
    input.riskPlanOk
      ? 'A position was sized inside the capital allocation and risk budget.'
      : (input.riskPlanReason ?? 'No position could be sized inside the configured limits.'),
  );

  // A soft pre-check only. `OrderService` computes the authoritative simulated
  // margin and rejects on it; this exists so an obviously unaffordable intent
  // is refused as a POLICY decision with an explanation, rather than becoming a
  // REJECTED order row that looks like an OMS fault in the console.
  const affordable = input.estimatedCost <= input.availableCash;
  push(
    'affordable',
    affordable,
    `Estimated ${formatInr(input.estimatedCost)} against ${formatInr(input.availableCash)} available.`,
  );

  const failed = checks.find((c) => !c.passed);
  return {
    allowed: !failed,
    checks,
    reason: failed ? failed.detail : null,
    failedCheckId: failed ? failed.id : null,
    effectiveConfidenceFloor: effectiveFloor,
  };
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
