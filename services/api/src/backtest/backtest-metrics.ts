import { METRIC_MIN_SAMPLE } from './backtest-config';
import type { SimEquityPoint, SimResult, SimTrade } from './execution-simulator';
import { round2, round4 } from './execution-simulator';

/**
 * Performance metrics, computed once, from the simulator's own output.
 *
 * ## Null is a result
 *
 * Sharpe over four trades is not a small Sharpe, it is not a Sharpe. The same
 * goes for CAGR over eleven days and for a profit factor with no losing trade
 * in the sample. Every metric here that needs a sample to mean anything returns
 * `null` below that sample, and the UI renders "not enough trades" rather than
 * a number that reads like evidence.
 *
 * That is a deliberate, and slightly unusual, choice: it is easier to print
 * `0.00` and let the reader decide. But a backtest exists to be acted on, and a
 * meaningless number in a metrics grid is indistinguishable from a meaningful
 * one at a glance.
 *
 * ## Drawdown is measured on the curve, not on the trades
 *
 * Trade-sequence drawdown misses everything that happened while a position was
 * open — including the excursion that would have ended the account. The curve
 * is marked to market every bar, so the peak-to-trough here is the one the
 * trader would have lived through.
 */

export interface BacktestMetrics {
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  totalReturnPct: number;
  cagrPct: number | null;

  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  winRatePct: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  largestWin: number | null;
  largestLoss: number | null;

  maxDrawdownPct: number;
  maxDrawdownAmount: number;
  maxDrawdownDays: number;
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  riskReward: number | null;

  totalFees: number;
  totalSlippage: number;
  averageSlippage: number | null;
  rejectedSignals: number;
  skippedSignals: number;
  exposurePct: number;

  averageHoldingSeconds: number | null;
  exitReasons: Record<string, number>;
  /** Per-regime buckets, built ONLY from context the snapshot actually
   *  classified. A trade whose regime was unknown is counted under 'unknown'
   *  rather than assigned to one. */
  regimePerformance: RegimeBucket[];
  /** Why signals produced no trade, tallied. */
  refusalReasons: Record<string, number>;
  /** Metrics suppressed for insufficient sample, and the threshold. */
  suppressed: { metric: string; reason: string }[];
}

export interface RegimeBucket {
  dimension: 'trend' | 'volatility';
  label: string;
  trades: number;
  netPnl: number;
  winRatePct: number | null;
}

/** Bars per year, per timeframe — for annualising a bar-sampled return series. */
const BARS_PER_YEAR: Record<string, number> = {
  // 250 NSE sessions x 375 minutes.
  '1m': 250 * 375,
  '5m': 250 * 75,
  '15m': 250 * 25,
  '1h': 250 * 6,
  '1d': 250,
};

export function computeMetrics(input: {
  sim: SimResult;
  initialCapital: number;
  timeframe: string;
  firstBarAt: Date | null;
  lastBarAt: Date | null;
}): BacktestMetrics {
  const { sim, initialCapital, timeframe, firstBarAt, lastBarAt } = input;
  const trades = sim.trades;
  const suppressed: { metric: string; reason: string }[] = [];

  const finalCapital = sim.finalPortfolioValue;
  const totalPnl = round2(finalCapital - initialCapital);
  const totalReturnPct = initialCapital > 0 ? round4((totalPnl / initialCapital) * 100) : 0;

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const flats = trades.filter((t) => t.netPnl === 0);
  const n = trades.length;

  const grossWin = sum(wins.map((t) => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)));

  // ---- Drawdown, from the marked-to-market curve --------------------------
  const dd = drawdown(sim.equity, initialCapital);

  // ---- Return series, for the risk ratios ---------------------------------
  const returns = barReturns(sim.equity);
  const barsPerYear = BARS_PER_YEAR[timeframe] ?? 250;
  const enoughForRatios = n >= METRIC_MIN_SAMPLE && returns.length >= 30;
  if (!enoughForRatios) {
    suppressed.push({
      metric: 'sharpe/sortino/volatility',
      reason: `Needs at least ${METRIC_MIN_SAMPLE} trades and 30 return observations; this run has ${n} and ${returns.length}.`,
    });
  }

  const sd = enoughForRatios ? stdev(returns) : null;
  const meanRet = enoughForRatios ? mean(returns) : null;
  const downside = enoughForRatios ? stdev(returns.filter((r) => r < 0)) : null;

  // ---- CAGR ---------------------------------------------------------------
  const spanDays =
    firstBarAt && lastBarAt ? (lastBarAt.getTime() - firstBarAt.getTime()) / 86_400_000 : 0;
  // Below a quarter, annualising multiplies noise by four or more and reports
  // it as an annual rate. Anyone reading "+840% CAGR" off eleven days is being
  // misled by arithmetic, not informed by it.
  const cagrMeaningful = spanDays >= 90 && initialCapital > 0 && finalCapital > 0;
  if (!cagrMeaningful) {
    suppressed.push({
      metric: 'cagrPct',
      reason: `Needs at least 90 days of history to annualise; this run covers ${Math.round(spanDays)}.`,
    });
  }
  const cagrPct = cagrMeaningful
    ? round4((Math.pow(finalCapital / initialCapital, 365 / spanDays) - 1) * 100)
    : null;

  const winRateMeaningful = n > 0;
  const profitFactorMeaningful = grossLoss > 0;
  if (n > 0 && !profitFactorMeaningful) {
    suppressed.push({
      metric: 'profitFactor',
      reason: 'No losing trade in the sample — the ratio is undefined, not infinite.',
    });
  }

  const rejected = sim.skips.filter((s) => s.kind === 'REJECTED');
  const skipped = sim.skips.filter((s) => s.kind === 'SKIPPED');

  return {
    initialCapital: round2(initialCapital),
    finalCapital: round2(finalCapital),
    totalPnl,
    totalReturnPct,
    cagrPct,

    totalTrades: n,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakEvenTrades: flats.length,
    winRatePct: winRateMeaningful ? round4((wins.length / n) * 100) : null,
    averageWin: wins.length ? round2(grossWin / wins.length) : null,
    averageLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: profitFactorMeaningful ? round4(grossWin / grossLoss) : null,
    expectancy: n ? round2(sum(trades.map((t) => t.netPnl)) / n) : null,
    largestWin: wins.length ? round2(Math.max(...wins.map((t) => t.netPnl))) : null,
    largestLoss: losses.length ? round2(Math.min(...losses.map((t) => t.netPnl))) : null,

    maxDrawdownPct: dd.maxPct,
    maxDrawdownAmount: dd.maxAmount,
    maxDrawdownDays: dd.days,
    volatilityPct: sd === null ? null : round4(sd * Math.sqrt(barsPerYear) * 100),
    // Excess return over a zero risk-free rate, annualised. The rate is zero
    // rather than a guessed 6-7% on purpose: a wrong constant would be silently
    // baked into every result, and the comparison between two backtests — which
    // is what this number is actually used for — is unaffected by it.
    sharpe: sd && meanRet !== null && sd > 0 ? round4((meanRet / sd) * Math.sqrt(barsPerYear)) : null,
    sortino:
      downside && meanRet !== null && downside > 0 ? round4((meanRet / downside) * Math.sqrt(barsPerYear)) : null,
    riskReward:
      wins.length && losses.length
        ? round4(grossWin / wins.length / (grossLoss / losses.length))
        : null,

    totalFees: round2(sum(trades.map((t) => t.fees))),
    totalSlippage: round2(sum(trades.map((t) => t.slippageCost))),
    averageSlippage: n ? round2(sum(trades.map((t) => t.slippageCost)) / n) : null,
    rejectedSignals: rejected.length,
    skippedSignals: skipped.length,
    exposurePct: sim.barsWalked ? round4((sim.exposedBars / sim.barsWalked) * 100) : 0,

    averageHoldingSeconds: n ? Math.round(sum(trades.map((t) => t.holdingSeconds)) / n) : null,
    exitReasons: tally(trades.map((t) => t.exitReason)),
    regimePerformance: regimeBuckets(trades),
    refusalReasons: tally(sim.skips.map((s) => normaliseReason(s.reason))),
    suppressed,
  };
}

/**
 * Peak-to-trough on the equity curve, plus how long the account spent below its
 * high-water mark.
 *
 * The duration runs to RECOVERY, or to the end of the run when the account
 * never recovered — and the two are not distinguished in the number, so the UI
 * says which one it is. "94 days" means something very different if the run
 * ended still under water.
 */
export function drawdown(
  equity: SimEquityPoint[],
  initialCapital: number,
): { maxPct: number; maxAmount: number; days: number; recovered: boolean } {
  if (!equity.length) return { maxPct: 0, maxAmount: 0, days: 0, recovered: true };

  let peak = initialCapital;
  let peakAt = equity[0].at.getTime();
  let maxPct = 0;
  let maxAmount = 0;
  let worstStart = peakAt;
  let worstEnd = peakAt;
  let worstRecovered = true;

  for (const p of equity) {
    if (p.portfolioValue >= peak) {
      peak = p.portfolioValue;
      peakAt = p.at.getTime();
      continue;
    }
    const amount = peak - p.portfolioValue;
    const pct = peak > 0 ? (amount / peak) * 100 : 0;
    if (pct > maxPct) {
      maxPct = pct;
      maxAmount = amount;
      worstStart = peakAt;
      worstEnd = p.at.getTime();
      worstRecovered = false;
    }
  }

  // Did the account get back to the peak that preceded the worst drawdown?
  if (maxPct > 0) {
    const target = equity.find((p) => p.at.getTime() === worstStart)?.portfolioValue ?? peak;
    const recovery = equity.find((p) => p.at.getTime() > worstEnd && p.portfolioValue >= target);
    if (recovery) {
      worstRecovered = true;
      worstEnd = recovery.at.getTime();
    } else {
      worstEnd = equity[equity.length - 1].at.getTime();
    }
  }

  return {
    maxPct: round4(maxPct),
    maxAmount: round2(maxAmount),
    days: maxPct > 0 ? Math.max(0, Math.round((worstEnd - worstStart) / 86_400_000)) : 0,
    recovered: worstRecovered,
  };
}

/** Bar-over-bar simple returns on portfolio value. */
export function barReturns(equity: SimEquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].portfolioValue;
    if (prev > 0) out.push((equity[i].portfolioValue - prev) / prev);
  }
  return out;
}

/**
 * Per-regime performance, from the context stored on each trade.
 *
 * Only labels the snapshot actually produced are bucketed. A trade whose regime
 * the snapshot could not classify lands in 'unknown' — it is NOT distributed
 * across the known buckets, which would manufacture the very correlation this
 * exists to reveal.
 */
export function regimeBuckets(trades: SimTrade[]): RegimeBucket[] {
  const buckets: RegimeBucket[] = [];
  for (const dimension of ['trend', 'volatility'] as const) {
    const groups = new Map<string, SimTrade[]>();
    for (const t of trades) {
      const raw = t.marketContext?.[dimension === 'trend' ? 'trend' : 'volatilityRegime'];
      const label = typeof raw === 'string' && raw ? raw : 'unknown';
      const list = groups.get(label) ?? [];
      list.push(t);
      groups.set(label, list);
    }
    for (const [label, list] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      const wins = list.filter((t) => t.netPnl > 0).length;
      buckets.push({
        dimension,
        label,
        trades: list.length,
        netPnl: round2(sum(list.map((t) => t.netPnl))),
        // A win rate over three trades is not a win rate. Same rule as above.
        winRatePct: list.length >= 5 ? round4((wins / list.length) * 100) : null,
      });
    }
  }
  return buckets;
}

/**
 * Down-sample a curve for storage while keeping every point that carries
 * information.
 *
 * A 1m run over two months is ~8,800 bars. Storing all of them is possible but
 * pointless for a chart a few hundred pixels wide — EXCEPT that naive striding
 * would drop the exact bars that matter: the drawdown trough, the peak that
 * preceded it, and every bar a trade opened or closed on. Those are pinned
 * first, then the remainder is strided to fill the budget.
 */
export function sampleEquity(equity: SimEquityPoint[], keepIndices: Set<number>, budget = 4_000): SimEquityPoint[] {
  if (equity.length <= budget) return equity;

  const must = new Set<number>(keepIndices);
  // The three points a reader looks for, none of which a stride would keep by
  // luck: the highest value, the lowest value, and the deepest drawdown (which
  // is not necessarily the lowest value — a later dip from a higher peak can be
  // a worse drawdown at a higher absolute level).
  let peakIdx = 0;
  let lowIdx = 0;
  let deepestDdIdx = 0;
  for (let i = 1; i < equity.length; i++) {
    if (equity[i].portfolioValue > equity[peakIdx].portfolioValue) peakIdx = i;
    if (equity[i].portfolioValue < equity[lowIdx].portfolioValue) lowIdx = i;
    if (equity[i].drawdownPct > equity[deepestDdIdx].drawdownPct) deepestDdIdx = i;
  }
  must.add(0);
  must.add(equity.length - 1);
  must.add(peakIdx);
  must.add(lowIdx);
  must.add(deepestDdIdx);

  const stride = Math.ceil(equity.length / Math.max(1, budget - must.size));
  for (let i = 0; i < equity.length; i += stride) must.add(i);

  return Array.from(must)
    .sort((a, b) => a - b)
    .map((i) => equity[i]);
}

// ─────────────────────────────────────────────────────────────── arithmetic

function sum(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0);
}
function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
/** Sample standard deviation (n-1). Returns 0 for fewer than two values. */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}
function tally(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
/** Collapse the variable part of a refusal so the tally groups by cause. */
function normaliseReason(reason: string): string {
  return reason.replace(/₹[\d,.]+/g, '₹…').replace(/\b\d+\b/g, 'N');
}
