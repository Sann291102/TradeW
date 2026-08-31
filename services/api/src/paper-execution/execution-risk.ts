/**
 * How much to buy, where the stop goes, and where the target goes.
 *
 * Pure and dependency-free, like `execution-policy.ts` and
 * `execution-account.ts` — the caller reads the wallet and the quote, this
 * decides. That split is what lets every number below be asserted without a
 * database, and it keeps the arithmetic in ONE place instead of spread across
 * the executor and the position manager.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE PERCENTAGES OF THREE DIFFERENT THINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The single most dangerous thing this module could do is quietly mix its own
 * bases, so each one is named explicitly and the choice is justified against
 * the repository's own knowledge rather than picked:
 *
 *   `capitalAllocationPct` — 20% OF ACCOUNT EQUITY.
 *       The most premium this ONE position may cost. An exposure cap.
 *
 *   `riskPerTradePct`      — 3% OF ACCOUNT EQUITY.
 *       The most this trade may LOSE before its stop fires. Not 3% of the
 *       trade's own cost.
 *
 *       This is the reading `knowledge-base/risk-management/position-sizing.yaml`
 *       states: *"setting exposure so that the loss incurred if a position
 *       fails represents a predetermined fraction of CAPITAL"*. The alternative
 *       reading — 3% of the premium paid — was rejected because it is
 *       incoherent for options: a 3%-of-premium stop on a ₹120 contract is 3.6
 *       points, which is intraday noise on any index option, so every position
 *       would be stopped within seconds of entry and the "risk model" would be
 *       a random exit generator.
 *
 *   `rewardPerTradePct`    — 9% OF ACCOUNT EQUITY.
 *       Same base as the risk, which is what makes the pair a clean 3R rather
 *       than two numbers measured against different things.
 *
 * `allocatedCapital` — the premium ACTUALLY deployed — is computed and stored
 * separately from the allocation CEILING, because they differ whenever whole
 * lots do not divide the ceiling evenly, and reporting the ceiling as though
 * it were the deployment would overstate exposure on every trade.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SIZING COMES BEFORE THE STOP, AND THE STOP BEFORE THE TARGET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is a genuine circularity here: quantity depends on the stop distance
 * (risk = distance × quantity), and the stop distance depends on quantity if
 * you want to spend the budget exactly. It is resolved in one direction:
 *
 *   1. A FLOOR stop distance is assumed (`MIN_STOP_FRACTION` of the premium).
 *      This is the tightest stop that is a stop rather than noise.
 *   2. Quantity is capped by what that floor stop permits inside the risk
 *      budget, by the allocation ceiling, and by the profile's own `lots`.
 *      The tightest of the three binds.
 *   3. THEN the stop distance is widened to spend the remaining budget, capped
 *      at `MAX_STOP_FRACTION` so a stop is never "wait for the option to
 *      expire worthless".
 *
 * Because step 3 only ever REDUCES the distance below `riskBudget / quantity`,
 * the realised risk can never exceed the budget. That invariant is asserted in
 * `execution-risk.spec.ts` over a large sweep of inputs rather than argued for
 * here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT MODELLED, STATED PLAINLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The stop is a fraction of the PREMIUM, not a structural level on the index
 * translated through the option's delta.
 * `knowledge-base/risk-management/stop-loss-placement.yaml` describes
 * structural placement as the better practice, and it is right — but a
 * structural stop on the underlying can only be converted into a premium level
 * with a delta, and the option chain this platform reads carries OI, volume
 * and IV but NOT Greeks. Deriving a delta from IV here would mean pricing the
 * option ourselves and then presenting the output as though it came from the
 * market. A premium-fraction stop is the honest thing that is actually
 * available; it is documented as a known limitation rather than dressed up.
 */

/** Long options only, so every formula below assumes a BUY that profits upward. */
export type PlannedSide = 'BUY';

export interface RiskPlanInput {
  /** Cash plus margin already blocked — the account's whole paper capital. */
  walletEquity: number;
  /** Live premium the entry would pay (the ask, for a long). */
  entryPrice: number;
  /** Exchange lot size for this contract. Quantity is always a multiple. */
  lotSize: number;
  /** The profile's configured size, in lots. An upper bound, never a target. */
  maxLots: number;

  /** The three percentages. See the header for what each is a percentage OF. */
  capitalAllocationPct: number;
  riskPerTradePct: number;
  rewardPerTradePct: number;
}

export interface RiskPlanStep {
  id: string;
  label: string;
  detail: string;
}

export interface RiskPlan {
  ok: boolean;
  /** Why no position could be sized, or null when one could. */
  reason: string | null;
  /** Groupable form of `reason`, for the rejection breakdown. */
  failedCheckId: string | null;

  // ---- The bases, each named ---------------------------------------------
  walletEquity: number;
  /** walletEquity × capitalAllocationPct — the exposure CEILING. */
  allocationCeiling: number;
  /** walletEquity × riskPerTradePct — the loss budget. */
  riskBudget: number;
  /** walletEquity × rewardPerTradePct — the gain objective. */
  rewardTarget: number;

  // ---- The position ------------------------------------------------------
  lots: number;
  quantity: number;
  entryPrice: number;
  /** entryPrice × quantity — the premium ACTUALLY deployed. */
  allocatedCapital: number;

  // ---- The levels --------------------------------------------------------
  /** Premium points below entry. */
  stopDistance: number;
  /** Premium points above entry. */
  targetDistance: number;
  stopPrice: number;
  targetPrice: number;
  /** stopDistance × quantity. ALWAYS ≤ riskBudget. */
  riskAtStop: number;
  /** targetDistance × quantity. */
  rewardAtTarget: number;
  /** rewardAtTarget / riskAtStop. Equals rewardPct/riskPct by construction. */
  rMultiple: number;

  /** Which of the three caps actually bound the size. */
  bindingConstraint: 'profile-lots' | 'risk-budget' | 'allocation-ceiling' | 'none';
  /** Every step of the arithmetic, in order, for the journal. */
  steps: RiskPlanStep[];
}

/**
 * The tightest stop this module will ever place, as a fraction of the premium.
 *
 * 10%. An index option routinely moves several percent of its premium inside a
 * single minute, so a stop nearer than this is a coin flip on microstructure
 * rather than a statement about the trade being wrong. It exists as a QUANTITY
 * cap rather than as a post-hoc clamp on the distance, because clamping the
 * distance upward after sizing would push realised risk above the budget.
 */
export const MIN_STOP_FRACTION = 0.1;

/**
 * The widest stop, as a fraction of the premium.
 *
 * 35%. Beyond this the "stop" stops being protection and becomes a bet that
 * the option does not expire worthless — and since a long option's loss is
 * capped at the premium anyway, a stop at 80% of premium is barely different
 * from no stop at all while looking like one on a dashboard.
 */
export const MAX_STOP_FRACTION = 0.35;

export function planRisk(input: RiskPlanInput): RiskPlan {
  const steps: RiskPlanStep[] = [];
  const step = (id: string, label: string, detail: string) => steps.push({ id, label, detail });

  const {
    walletEquity,
    entryPrice,
    lotSize,
    maxLots,
    capitalAllocationPct,
    riskPerTradePct,
    rewardPerTradePct,
  } = input;

  const allocationCeiling = round2(walletEquity * (capitalAllocationPct / 100));
  const riskBudget = round2(walletEquity * (riskPerTradePct / 100));
  const rewardTarget = round2(walletEquity * (rewardPerTradePct / 100));

  const fail = (failedCheckId: string, reason: string): RiskPlan => ({
    ok: false,
    reason,
    failedCheckId,
    walletEquity,
    allocationCeiling,
    riskBudget,
    rewardTarget,
    lots: 0,
    quantity: 0,
    entryPrice,
    allocatedCapital: 0,
    stopDistance: 0,
    targetDistance: 0,
    stopPrice: 0,
    targetPrice: 0,
    riskAtStop: 0,
    rewardAtTarget: 0,
    rMultiple: 0,
    bindingConstraint: 'none',
    steps,
  });

  // ---- Inputs that make the arithmetic meaningless ------------------------
  if (!(walletEquity > 0)) return fail('risk-equity', `Cannot size a position against ${formatInr(walletEquity)} of equity.`);
  if (!(entryPrice > 0)) return fail('risk-entry-price', 'Cannot size a position against a non-positive premium.');
  if (!Number.isInteger(lotSize) || lotSize < 1) return fail('risk-lot-size', `Invalid lot size ${lotSize}.`);
  if (!Number.isInteger(maxLots) || maxLots < 1) return fail('risk-max-lots', `Invalid profile size ${maxLots} lots.`);
  if (!(riskPerTradePct > 0)) return fail('risk-percent', 'Risk per trade must be a positive percentage.');
  if (!(rewardPerTradePct > 0)) return fail('reward-percent', 'Reward per trade must be a positive percentage.');
  if (!(capitalAllocationPct > 0)) return fail('allocation-percent', 'Capital allocation must be a positive percentage.');

  step(
    'bases',
    'Bases',
    `Equity ${formatInr(walletEquity)} → allocation ceiling ${formatInr(allocationCeiling)} (${capitalAllocationPct}%), ` +
      `risk budget ${formatInr(riskBudget)} (${riskPerTradePct}%), reward target ${formatInr(rewardTarget)} (${rewardPerTradePct}%).`,
  );

  const costPerLot = round2(entryPrice * lotSize);

  // ---- 1. The floor stop, and the quantity it permits ---------------------
  const floorStopDistance = entryPrice * MIN_STOP_FRACTION;
  const lotsByRisk = Math.floor(riskBudget / (floorStopDistance * lotSize));
  const lotsByAllocation = Math.floor(allocationCeiling / costPerLot);

  step(
    'size-caps',
    'Size caps',
    `At the ${(MIN_STOP_FRACTION * 100).toFixed(0)}% floor stop (${floorStopDistance.toFixed(2)} pts), the risk budget permits ` +
      `${lotsByRisk} lot(s); the allocation ceiling permits ${lotsByAllocation} lot(s) at ${formatInr(costPerLot)} per lot; ` +
      `the profile permits ${maxLots}.`,
  );

  const lots = Math.min(maxLots, lotsByRisk, lotsByAllocation);
  if (lots < 1) {
    const binding = lotsByAllocation < 1 ? 'allocation ceiling' : 'risk budget';
    return fail(
      lotsByAllocation < 1 ? 'allocation-ceiling' : 'risk-budget',
      `One lot of ${formatInr(costPerLot)} does not fit inside the ${binding} ` +
        `(${formatInr(lotsByAllocation < 1 ? allocationCeiling : riskBudget)}). No position was sized.`,
    );
  }

  const bindingConstraint: RiskPlan['bindingConstraint'] =
    lots === maxLots && maxLots <= lotsByRisk && maxLots <= lotsByAllocation
      ? 'profile-lots'
      : lots === lotsByRisk && lotsByRisk <= lotsByAllocation
        ? 'risk-budget'
        : 'allocation-ceiling';

  const quantity = lots * lotSize;
  const allocatedCapital = round2(entryPrice * quantity);

  step(
    'size',
    'Position size',
    `${lots} lot(s) × ${lotSize} = ${quantity} units at ${entryPrice.toFixed(2)} = ${formatInr(allocatedCapital)} deployed ` +
      `(bound by the ${bindingConstraint.replace('-', ' ')}).`,
  );

  // ---- 2. Widen the stop to spend the budget, but never past the cap ------
  //
  // `riskBudget / quantity` is the distance that spends the budget exactly.
  // The cap only ever reduces it, which is what preserves `riskAtStop ≤
  // riskBudget` no matter what the inputs were.
  const budgetStopDistance = riskBudget / quantity;
  const cappedStopDistance = entryPrice * MAX_STOP_FRACTION;
  // FLOORED to the paisa, not rounded.
  //
  // `round2` was the obvious call and it breaks the invariant: a budget
  // distance of 20.0086 rounds UP to 20.01, and 20.01 × 1,500 units is ₹1,506
  // against a ₹1,500 budget. Small, but it is the one number this module
  // exists to bound, and "the risk limit is exceeded by rounding" is not a
  // sentence that should be true. Flooring can only ever reduce the distance,
  // so it can only ever reduce realised risk. Caught by the swept invariant in
  // `execution-risk.spec.ts`, not by inspection.
  const stopDistance = floor2(Math.min(budgetStopDistance, cappedStopDistance));

  if (!(stopDistance > 0)) {
    return fail('stop-distance', `Computed a non-positive stop distance from a ${entryPrice.toFixed(2)} premium.`);
  }

  // The R multiple is taken from the CONFIGURED pair, not from the budget
  // numbers — so a stop that was capped still produces a 3R target rather than
  // an unreachable one derived from the full reward budget over a small stop.
  const rMultiple = rewardPerTradePct / riskPerTradePct;
  const targetDistance = round2(stopDistance * rMultiple);

  const stopPrice = round2(Math.max(0.05, entryPrice - stopDistance));
  const targetPrice = round2(entryPrice + targetDistance);
  const riskAtStop = round2(stopDistance * quantity);
  const rewardAtTarget = round2(targetDistance * quantity);

  step(
    'stop',
    'Stop loss',
    budgetStopDistance <= cappedStopDistance
      ? `Stop ${stopDistance.toFixed(2)} pts below entry — the distance that spends the ${formatInr(riskBudget)} budget over ${quantity} units. Risk at stop ${formatInr(riskAtStop)}.`
      : `Stop capped at ${(MAX_STOP_FRACTION * 100).toFixed(0)}% of premium (${stopDistance.toFixed(2)} pts); spending the full budget would have needed ${budgetStopDistance.toFixed(2)} pts, which is not a stop. Risk at stop ${formatInr(riskAtStop)}, inside the ${formatInr(riskBudget)} budget.`,
  );
  step(
    'target',
    'Target',
    `Target ${targetDistance.toFixed(2)} pts above entry — ${rMultiple.toFixed(2)}× the stop distance ` +
      `(${rewardPerTradePct}% reward against ${riskPerTradePct}% risk). Reward at target ${formatInr(rewardAtTarget)}.`,
  );

  return {
    ok: true,
    reason: null,
    failedCheckId: null,
    walletEquity,
    allocationCeiling,
    riskBudget,
    rewardTarget,
    lots,
    quantity,
    entryPrice,
    allocatedCapital,
    stopDistance,
    targetDistance,
    stopPrice,
    targetPrice,
    riskAtStop,
    rewardAtTarget,
    rMultiple,
    bindingConstraint,
    steps,
  };
}

/**
 * Where the trailing stop sits, given how far the trade has gone in favour.
 *
 * ## The rule, stated plainly
 *
 * Every `stepPoints` of favourable movement FROM ENTRY advances protection by
 * one step. The first step moves the trail to breakeven; each one after that
 * moves it another `stepPoints`. So at entry 120 with a 3-point step:
 *
 *     high 122  → 0 steps → no trail yet
 *     high 123  → 1 step  → trail at 120 (breakeven)
 *     high 126  → 2 steps → trail at 123
 *     high 129  → 3 steps → trail at 126
 *
 * ## Two properties that must hold, and why
 *
 * It is computed from the HIGH-WATER MARK, never from the current price, so a
 * retrace cannot loosen protection — the trail is a function of the best the
 * trade has ever been, which is monotonic by construction.
 *
 * And it is QUANTISED to whole steps rather than continuous. A continuous
 * trail sitting a fixed distance behind price would rewrite the level on every
 * tick, which for a position held twenty minutes is several hundred database
 * writes that each say almost nothing. Whole steps make each write a real
 * event worth recording in `ExecutionTrailAdjustment`.
 */
export interface TrailComputation {
  /** Whole steps of favourable movement booked so far. */
  steps: number;
  /** The trail level, or null when fewer than one step has been made. */
  trailPrice: number | null;
}

export function computeTrail(input: {
  entryPrice: number;
  highWaterPrice: number;
  stepPoints: number;
}): TrailComputation {
  const { entryPrice, highWaterPrice, stepPoints } = input;
  if (!(stepPoints > 0) || !(entryPrice > 0)) return { steps: 0, trailPrice: null };
  const favourable = highWaterPrice - entryPrice;
  if (!(favourable >= stepPoints)) return { steps: 0, trailPrice: null };
  const steps = Math.floor(favourable / stepPoints);
  return { steps, trailPrice: round2(entryPrice + (steps - 1) * stepPoints) };
}

/**
 * The level an exit actually triggers on: the wider of the initial stop and
 * the trail.
 *
 * The initial stop is never rewritten (the journal has to be able to say what
 * was risked AT ENTRY), so "the effective stop" is a computed maximum rather
 * than a mutated field. Once the trail activates at breakeven it is always
 * above the initial stop for a long, so this reduces to "the trail, once there
 * is one" — but expressing it as a maximum means a future short-side
 * implementation cannot silently invert it by assuming which one is larger.
 */
export function effectiveStop(stopPrice: number, trailPrice: number | null): number {
  return trailPrice == null ? stopPrice : Math.max(stopPrice, trailPrice);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Toward zero, to the paisa. Used wherever rounding up would widen risk. */
function floor2(n: number): number {
  return Math.floor(n * 100) / 100;
}

function formatInr(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}
