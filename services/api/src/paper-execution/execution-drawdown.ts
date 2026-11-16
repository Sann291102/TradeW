/**
 * Give-back and concentration math for the autonomous agents.
 *
 * Pure and dependency-free, for the same reason `execution-policy.ts` is: every
 * rule here decides whether an agent may open a position, and a rule that needs
 * a database to assert is a rule that gets asserted once and then trusted.
 *
 * ## Why drawdown exists beside `maxLossPerDay`
 *
 * They are not the same bound and neither implies the other.
 *
 *   maxLossPerDay  is ABSOLUTE: "never finish the day worse than -25,000".
 *   maxDrawdownPct is RELATIVE:  "never hand back more than 30% of the best
 *                                 the day has been".
 *
 * A session that runs +50,000 by noon and is +5,000 by 14:00 has lost 45,000 of
 * real money and tripped no absolute floor at all — realized P&L never went
 * negative, so `daily-loss-limit` passed on every single pass. That day is the
 * one this bound exists for, and it is the commonest way an otherwise-good
 * strategy returns nothing.
 *
 * ## The peak starts at zero, deliberately
 *
 * The day begins flat, so the running peak is seeded at 0 rather than at the
 * first trade's P&L. That makes drawdown at least as strict as the loss floor
 * on a day that is red throughout (peak 0, current -10,000 → drawdown 10,000),
 * which is the correct direction: a bound meant to stop give-back must not go
 * quiet simply because the account never got ahead.
 */

/** One booked trade on the account today. Only the two fields the curve needs. */
export interface RealizedTrade {
  executedAt: Date;
  realizedPnl: number;
}

export interface DrawdownRead {
  /** Highest cumulative realized P&L reached today. Never below 0. */
  peak: number;
  /** Cumulative realized P&L right now. */
  current: number;
  /** `peak - current`. Never negative. */
  drawdown: number;
  /**
   * Drawdown as a percentage of the equity the day STARTED with.
   *
   * Null when that base is not a usable denominator (zero or negative), because
   * a percentage of nothing is not 0% — it is unknown, and reporting 0% would
   * silently pass a bound that was never actually evaluated.
   */
  drawdownPct: number | null;
}

/**
 * Rebuild today's realized equity curve and read its give-back.
 *
 * `startOfDayEquity` is the equity the account opened with — the caller derives
 * it as `walletEquity - realizedPnlToday` rather than storing a high-water mark,
 * so this can never drift from the ledger it is measured against.
 *
 * Trades are sorted by `executedAt`; ties keep input order, because two fills
 * stamped in the same millisecond have no meaningful order and re-ordering them
 * would move the peak for no reason.
 */
export function computeDailyDrawdown(trades: RealizedTrade[], startOfDayEquity: number): DrawdownRead {
  const ordered = [...trades].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());

  let cumulative = 0;
  // Seeded at 0: the day starts flat. See the note above.
  let peak = 0;
  for (const trade of ordered) {
    cumulative += trade.realizedPnl;
    if (cumulative > peak) peak = cumulative;
  }

  const drawdown = Math.max(0, peak - cumulative);
  const drawdownPct = startOfDayEquity > 0 ? (drawdown / startOfDayEquity) * 100 : null;

  return {
    peak: round2(peak),
    current: round2(cumulative),
    drawdown: round2(drawdown),
    drawdownPct: drawdownPct == null ? null : round3(drawdownPct),
  };
}

/**
 * Has the account given back more than the profile allows?
 *
 * Returns false when the bound is not configured (`null` = disabled) and when
 * the percentage could not be computed — an unmeasurable bound must not become
 * a silent stop, and it is reported as its own check detail rather than folded
 * into a pass.
 */
export function breachesDrawdown(read: DrawdownRead, maxDrawdownPct: number | null): boolean {
  if (maxDrawdownPct == null) return false;
  if (read.drawdownPct == null) return false;
  return read.drawdownPct >= maxDrawdownPct;
}

export interface ExposureRead {
  /** Premium already committed across this profile's open positions. */
  openExposure: number;
  /** What this pass would add. */
  proposedExposure: number;
  /** The sum the bound is actually applied to. */
  totalExposure: number;
  /** `totalExposure` as a percentage of wallet equity, or null when equity is unusable. */
  exposurePct: number | null;
}

/**
 * Combined premium at risk if this pass fills.
 *
 * `capitalAllocationPct` already bounds ONE position. Nothing bounded their sum
 * once `maxOpenPositions` rose above 1, so three positions sized at a 20%
 * allocation each could commit 60% of the account while every individual check
 * passed. This is that sum.
 *
 * The proposed position is included on purpose: the question is whether the
 * account would be over-committed AFTER this fill, not whether it already is.
 */
export function computeExposure(args: {
  openPremiumAtRisk: number;
  proposedCost: number;
  walletEquity: number;
}): ExposureRead {
  const openExposure = Math.max(0, args.openPremiumAtRisk);
  const proposedExposure = Math.max(0, args.proposedCost);
  const totalExposure = openExposure + proposedExposure;
  const exposurePct = args.walletEquity > 0 ? (totalExposure / args.walletEquity) * 100 : null;

  return {
    openExposure: round2(openExposure),
    proposedExposure: round2(proposedExposure),
    totalExposure: round2(totalExposure),
    exposurePct: exposurePct == null ? null : round3(exposurePct),
  };
}

/** Same null-is-not-a-breach rule as `breachesDrawdown`. */
export function breachesExposure(read: ExposureRead, maxPortfolioExposurePct: number | null): boolean {
  if (maxPortfolioExposurePct == null) return false;
  if (read.exposurePct == null) return false;
  return read.exposurePct > maxPortfolioExposurePct;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
