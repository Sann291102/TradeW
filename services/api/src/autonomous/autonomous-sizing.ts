/**
 * Position sizing from the STOP DISTANCE.
 *
 *     account → allowed risk → stop distance → lot size → quantity
 *
 * ## Why this is not `planRisk`
 *
 * `execution-risk.ts::planRisk` already sizes the Sentinel path, and it is
 * correct for what it models: a long option held with no stop, where the risk
 * IS the whole premium, so `lots = riskBudget / (premium × lotSize)`.
 *
 * The autonomous brain always has a stop, and it is the defining feature of the
 * plan — the level the thesis dies at. Its risk per lot is therefore
 * `(entry − stop) × lotSize`, not `entry × lotSize`. Sizing off the full
 * premium when a stop exists systematically UNDER-sizes: a trade risking 30
 * points of a 150-point premium would be sized as though all 150 were at risk,
 * taking a fifth of the intended position and making every realised R a fifth
 * of what the plan said.
 *
 * Two different risk models, both correct for their own path. Sharing one
 * function would mean one of them is wrong.
 *
 * ## What it will not do
 *
 * Round up to reach a position. If the risk budget cannot pay for one whole
 * lot at the planned stop, the answer is no trade — not a smaller stop, not a
 * bigger budget, not a partial lot the OMS would reject anyway.
 */

export interface SizingInput {
  /** Whole paper capital: cash plus margin already blocked. */
  walletEquity: number;
  /** Percentage of equity this trade may risk. */
  riskPerTradePct: number;
  /** Percentage of equity this trade's cost may occupy. */
  capitalAllocationPct: number;
  /** Price the order is expected to fill at, in the TRADABLE space. */
  entryPrice: number;
  /** The stop, in the same space. */
  stopPrice: number;
  lotSize: number;
  /** Ceiling from the profile, in lots. */
  maxLots: number;
}

export interface SizingStep {
  id: string;
  detail: string;
}

export type SizingResult =
  | {
      ok: true;
      lots: number;
      quantity: number;
      riskBudget: number;
      stopDistance: number;
      riskPerLot: number;
      estimatedCost: number;
      /** Before the caps — what the risk budget alone would have bought. */
      calculatedQuantity: number;
      steps: SizingStep[];
    }
  | { ok: false; reason: string; detail: string; steps: SizingStep[] };

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function sizeFromRisk(input: SizingInput): SizingResult {
  const steps: SizingStep[] = [];
  const step = (id: string, detail: string) => steps.push({ id, detail });

  const { walletEquity, riskPerTradePct, capitalAllocationPct, entryPrice, stopPrice, lotSize, maxLots } = input;

  if (!(walletEquity > 0)) {
    return { ok: false, reason: 'no-equity', detail: 'The paper wallet has no positive equity to size against.', steps };
  }
  if (!(lotSize > 0) || !Number.isInteger(lotSize)) {
    return { ok: false, reason: 'invalid-lot-size', detail: `Lot size ${lotSize} is not a positive integer.`, steps };
  }
  if (!(entryPrice > 0)) {
    return { ok: false, reason: 'invalid-entry', detail: `Entry price ${entryPrice} is not positive.`, steps };
  }

  const stopDistance = round2(Math.abs(entryPrice - stopPrice));
  if (!(stopDistance > 0)) {
    // Dividing by this would produce an unbounded position.
    return {
      ok: false,
      reason: 'no-stop-distance',
      detail: `Entry ${entryPrice} and stop ${stopPrice} are the same price, so risk per unit is zero.`,
      steps,
    };
  }
  step('stop-distance', `Stop is ${stopDistance} away from the entry — that is 1R per unit.`);

  const riskBudget = round2(walletEquity * (riskPerTradePct / 100));
  step('risk-budget', `${riskPerTradePct}% of ${round2(walletEquity)} equity is ${riskBudget} of allowed risk.`);

  const riskPerLot = round2(stopDistance * lotSize);
  step('risk-per-lot', `One lot of ${lotSize} risks ${riskPerLot} to that stop.`);

  const calculatedLots = Math.floor(riskBudget / riskPerLot);
  step('lots-from-risk', `The risk budget alone affords ${calculatedLots} lot(s).`);

  if (calculatedLots < 1) {
    return {
      ok: false,
      reason: 'risk-budget-below-one-lot',
      detail:
        `One lot risks ${riskPerLot}, above the ${riskBudget} this trade may risk. Refusing rather than ` +
        `tightening the stop to fit the budget.`,
      steps,
    };
  }

  // Cost cap. Risk and cost are different limits: a cheap option can be inside
  // the risk budget while a large position in it still ties up more capital
  // than a single idea is allowed to occupy.
  const allocationCeiling = round2(walletEquity * (capitalAllocationPct / 100));
  const costPerLot = round2(entryPrice * lotSize);
  const affordableLots = Math.floor(allocationCeiling / costPerLot);
  step(
    'allocation-cap',
    `${capitalAllocationPct}% allocation is ${allocationCeiling}; at ${costPerLot} per lot that allows ${affordableLots} lot(s).`,
  );

  const lots = Math.min(calculatedLots, affordableLots, Math.max(0, Math.floor(maxLots)));
  step('lot-ceiling', `Profile ceiling is ${maxLots} lot(s); taking the smallest of the three: ${lots}.`);

  if (lots < 1) {
    return {
      ok: false,
      reason: 'allocation-below-one-lot',
      detail:
        `One lot costs ${costPerLot}, above the ${allocationCeiling} allocation ceiling. A whole lot is ` +
        `the minimum the venue accepts, so there is no smaller position to take.`,
      steps,
    };
  }

  const quantity = lots * lotSize;
  const estimatedCost = round2(entryPrice * quantity);
  step('quantity', `Final: ${lots} lot(s) = ${quantity} units, costing ${estimatedCost}, risking ${round2(stopDistance * quantity)}.`);

  return {
    ok: true,
    lots,
    quantity,
    riskBudget,
    stopDistance,
    riskPerLot,
    estimatedCost,
    calculatedQuantity: calculatedLots * lotSize,
    steps,
  };
}
