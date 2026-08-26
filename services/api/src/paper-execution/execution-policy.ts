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
  'fresh-market-data': 'Market data fresh',
  'before-square-off': 'Before square-off',
  'confidence-floor': 'Confidence floor',
  'max-open-positions': 'Open position limit',
  'max-orders-per-day': 'Daily order limit',
  'daily-loss-limit': 'Daily loss limit',
  affordable: 'Sufficient paper capital',
  'submission-raised': 'Submission raised',
  'oms-rejected': 'Rejected by the OMS',
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

  // ---- Market-data freshness (data-quality gate, not a risk gate) ---------
  //
  // Age, in milliseconds, of the live quote the decision priced against — `now`
  // minus the feed's own last-tick timestamp. Null when the feed provided no
  // timestamp for this read (see `requireFreshQuote` for how that is treated).
  quoteAgeMs: number | null;
  /** A quote older than this is refused. Trade only on live data. */
  maxQuoteAgeMs: number;
  /**
   * When true, a quote with NO timestamp (`quoteAgeMs === null`) is refused
   * rather than admitted — a strict mode for a deployment that would rather not
   * trade at all than trade blind. Default behaviour (false) admits an untimed
   * quote, so a feed that never learned to stamp ticks is not silently halted.
   */
  requireFreshQuote: boolean;
}

/**
 * Is the priced quote fresh enough to act on?
 *
 * Pure and exported so the freshness rule is asserted directly and reused by
 * the console's "how stale is the feed" read, rather than re-implemented there.
 * A missing timestamp is fresh unless the deployment demands one — a feed that
 * does not stamp its ticks must not become an accidental global halt.
 */
export function isQuoteFresh(quoteAgeMs: number | null, maxQuoteAgeMs: number, requireFreshQuote: boolean): boolean {
  if (quoteAgeMs === null) return !requireFreshQuote;
  return quoteAgeMs <= maxQuoteAgeMs;
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

  // Market-data freshness — a DATA-QUALITY gate, deliberately right after
  // market-open because a stale quote and a shut market are the same failure to
  // a trader: the price you would act on is not the price that is trading. A
  // paper fill against a price the feed stopped updating minutes ago is not a
  // realistic approximation of anything, so the correct outcome is NO TRADE with
  // a recorded reason — never a silent fill at a dangerous last-known price.
  const fresh = isQuoteFresh(input.quoteAgeMs, input.maxQuoteAgeMs, input.requireFreshQuote);
  push(
    'fresh-market-data',
    fresh,
    input.quoteAgeMs === null
      ? input.requireFreshQuote
        ? 'Refused: the feed provided no quote timestamp and this deployment requires a fresh, timestamped quote.'
        : 'The feed provided no quote timestamp; freshness could not be checked (admitted — strict mode is off).'
      : fresh
        ? `Quote is ${(input.quoteAgeMs / 1000).toFixed(1)}s old, within the ${(input.maxQuoteAgeMs / 1000).toFixed(0)}s freshness limit.`
        : `Refused: quote is ${(input.quoteAgeMs / 1000).toFixed(1)}s old, past the ${(input.maxQuoteAgeMs / 1000).toFixed(0)}s freshness limit — the market-data feed appears stale.`,
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

  const confidenceOk = input.confidence >= input.minConfidence;
  push(
    'confidence-floor',
    confidenceOk,
    `${input.confidence}% against this profile's ${input.minConfidence}% floor.`,
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
