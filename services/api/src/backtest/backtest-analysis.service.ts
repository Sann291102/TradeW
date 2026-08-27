import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BacktestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { BacktestMetrics, RegimeBucket } from './backtest-metrics';

/**
 * The optional reading of a finished backtest.
 *
 * ## What it is allowed to see
 *
 * The stored metrics, and nothing else. Not the bars, not the trade list, not
 * the strategy source. `buildEvidence` produces exactly the object that gets
 * looked at, and that object is persisted alongside the output — so every
 * sentence below can be traced to the number it came from, and a claim with no
 * supporting number in `evidence` is visibly a claim the analyser had no basis
 * for.
 *
 * ## Why the default path is deterministic
 *
 * Each finding here is a rule over a metric, with the metric quoted in the
 * finding. That makes the analysis auditable — a reader can disagree with the
 * threshold, which is a much better position than disagreeing with a sentence
 * whose origin is unknowable. `services/api` also has no LLM provider wired
 * (every model call in this platform happens inside `services/sentinel`), so a
 * model-written path here would be new infrastructure rather than a feature.
 * `generatedBy` records which produced it, and the UI shows that.
 *
 * ## What it can never do
 *
 * Change the backtest. `BacktestAnalysis` is a separate table with a one-way
 * foreign key; there is no code path from here that writes to `Backtest`,
 * `BacktestTrade` or `BacktestEquityPoint`. An analysis can be regenerated and
 * the result underneath it will not move.
 */

export const ANALYSIS_PROMPT_VERSION = 'deterministic-v1';

export interface AnalysisFinding {
  /** One sentence, in plain language. */
  statement: string;
  /** The metric keys this rests on — the traceability link. */
  basis: string[];
  /** The values of those metrics at the time of writing. */
  values: Record<string, number | string | null>;
}

export interface AnalysisOutput {
  strengths: AnalysisFinding[];
  weaknesses: AnalysisFinding[];
  failurePatterns: AnalysisFinding[];
  conditions: AnalysisFinding[];
  consistency: AnalysisFinding[];
  /** Stated plainly when the sample is too small to support any of it. */
  caveats: string[];
}

@Injectable()
export class BacktestAnalysisService {
  private readonly logger = new Logger(BacktestAnalysisService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generate(userId: string, backtestId: string) {
    const row = await this.prisma.backtest.findFirst({
      where: { id: backtestId, userId },
      include: { analysis: true },
    });
    if (!row) throw new NotFoundException('Backtest not found.');
    if (row.status !== BacktestStatus.COMPLETED) {
      throw new BadRequestException(`Only a completed backtest can be analysed; this one is ${row.status}.`);
    }
    if (row.analysis) return row.analysis;
    if (!row.metrics) throw new BadRequestException('This backtest has no stored metrics to analyse.');

    const metrics = row.metrics as unknown as BacktestMetrics;
    const evidence = buildEvidence(metrics, {
      symbol: row.symbol,
      timeframe: row.timeframe,
      strategyName: row.strategyName,
      barCount: row.barCount,
    });
    const output = analyse(metrics);

    return this.prisma.backtestAnalysis.create({
      data: {
        backtestId,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        output: output as unknown as Prisma.InputJsonValue,
        model: null,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        generatedBy: 'deterministic',
      },
    });
  }
}

/**
 * Exactly what the analyser is allowed to look at.
 *
 * Kept as its own function, and persisted verbatim, so "what did it know" is a
 * question with a stored answer rather than an inference from the code that
 * happened to be deployed that day.
 */
export function buildEvidence(
  m: BacktestMetrics,
  ctx: { symbol: string; timeframe: string; strategyName: string; barCount: number },
): Record<string, unknown> {
  return {
    context: ctx,
    returns: {
      initialCapital: m.initialCapital,
      finalCapital: m.finalCapital,
      totalPnl: m.totalPnl,
      totalReturnPct: m.totalReturnPct,
      cagrPct: m.cagrPct,
    },
    trades: {
      totalTrades: m.totalTrades,
      winningTrades: m.winningTrades,
      losingTrades: m.losingTrades,
      winRatePct: m.winRatePct,
      averageWin: m.averageWin,
      averageLoss: m.averageLoss,
      profitFactor: m.profitFactor,
      expectancy: m.expectancy,
      largestWin: m.largestWin,
      largestLoss: m.largestLoss,
      riskReward: m.riskReward,
      averageHoldingSeconds: m.averageHoldingSeconds,
    },
    risk: {
      maxDrawdownPct: m.maxDrawdownPct,
      maxDrawdownAmount: m.maxDrawdownAmount,
      maxDrawdownDays: m.maxDrawdownDays,
      volatilityPct: m.volatilityPct,
      sharpe: m.sharpe,
      sortino: m.sortino,
    },
    execution: {
      totalFees: m.totalFees,
      totalSlippage: m.totalSlippage,
      averageSlippage: m.averageSlippage,
      rejectedSignals: m.rejectedSignals,
      skippedSignals: m.skippedSignals,
      exposurePct: m.exposurePct,
    },
    distributions: {
      exitReasons: m.exitReasons,
      regimePerformance: m.regimePerformance,
      refusalReasons: m.refusalReasons,
    },
    suppressed: m.suppressed,
  };
}

/**
 * The rules. Each one names the metrics it read and quotes their values, so a
 * finding is never a claim the reader has to take on trust.
 *
 * Thresholds are conventional rather than derived, and that is stated in the
 * caveats — the point of the analysis is to direct attention, not to grade.
 */
export function analyse(m: BacktestMetrics): AnalysisOutput {
  const out: AnalysisOutput = {
    strengths: [],
    weaknesses: [],
    failurePatterns: [],
    conditions: [],
    consistency: [],
    caveats: [],
  };

  const f = (statement: string, basis: string[], values: Record<string, number | string | null>): AnalysisFinding => ({
    statement,
    basis,
    values,
  });

  // ── The sample question comes first, because it governs everything else ──
  if (m.totalTrades === 0) {
    out.caveats.push(
      'This run produced no trades, so there is nothing to characterise. The signal and refusal counts below say whether the strategy never fired, or fired and was refused.',
    );
    if (m.rejectedSignals + m.skippedSignals > 0) {
      out.failurePatterns.push(
        f(
          `The strategy fired, but every signal was turned away — ${m.rejectedSignals} rejected and ${m.skippedSignals} skipped.`,
          ['rejectedSignals', 'skippedSignals', 'refusalReasons'],
          { rejectedSignals: m.rejectedSignals, skippedSignals: m.skippedSignals },
        ),
      );
    }
    return out;
  }
  if (m.totalTrades < 20) {
    out.caveats.push(
      `Only ${m.totalTrades} trades. Everything below describes this particular sample, not the strategy — at this size a single trade moves most of these numbers materially.`,
    );
  }
  if (m.suppressed.length) {
    out.caveats.push(
      `Not computed for this run: ${m.suppressed.map((s) => s.metric).join(', ')}. ${m.suppressed[0].reason}`,
    );
  }
  out.caveats.push(
    'Thresholds used here are conventional rules of thumb, not results derived from your data. Read the findings as pointers to look at, not as a verdict.',
  );

  // ── Returns ────────────────────────────────────────────────────────────
  if (m.totalPnl > 0) {
    out.strengths.push(
      f(
        `Finished ahead: ${fmt(m.totalPnl)} on ${fmt(m.initialCapital)}, a ${m.totalReturnPct}% return.`,
        ['totalPnl', 'totalReturnPct'],
        { totalPnl: m.totalPnl, totalReturnPct: m.totalReturnPct },
      ),
    );
  } else {
    out.weaknesses.push(
      f(
        `Finished behind: ${fmt(m.totalPnl)} on ${fmt(m.initialCapital)}, a ${m.totalReturnPct}% return.`,
        ['totalPnl', 'totalReturnPct'],
        { totalPnl: m.totalPnl, totalReturnPct: m.totalReturnPct },
      ),
    );
  }

  // ── Costs relative to the result: the finding people miss ───────────────
  const costs = m.totalFees + m.totalSlippage;
  if (costs > 0 && Math.abs(m.totalPnl) > 0 && costs >= Math.abs(m.totalPnl) * 0.5) {
    out.failurePatterns.push(
      f(
        `Execution cost ${fmt(costs)} — ${Math.round((costs / Math.abs(m.totalPnl)) * 100)}% of the absolute result. The edge and the friction are the same order of magnitude here.`,
        ['totalFees', 'totalSlippage', 'totalPnl'],
        { totalFees: m.totalFees, totalSlippage: m.totalSlippage, totalPnl: m.totalPnl },
      ),
    );
  }

  // ── Win rate vs payoff ─────────────────────────────────────────────────
  if (m.winRatePct !== null && m.riskReward !== null) {
    if (m.winRatePct < 40 && m.riskReward >= 1.8) {
      out.strengths.push(
        f(
          `Low hit rate carried by payoff: wins ${m.winRatePct}% of the time, but the average win is ${m.riskReward}x the average loss.`,
          ['winRatePct', 'riskReward'],
          { winRatePct: m.winRatePct, riskReward: m.riskReward },
        ),
      );
    }
    if (m.winRatePct >= 55 && m.riskReward < 0.8) {
      out.weaknesses.push(
        f(
          `Wins often but small: ${m.winRatePct}% hit rate against a ${m.riskReward}x payoff — the losses are larger than the wins.`,
          ['winRatePct', 'riskReward'],
          { winRatePct: m.winRatePct, riskReward: m.riskReward },
        ),
      );
    }
  }
  if (m.profitFactor !== null) {
    const target = m.profitFactor >= 1.5 ? out.strengths : m.profitFactor < 1 ? out.weaknesses : out.consistency;
    target.push(
      f(
        `Profit factor ${m.profitFactor} — ${fmt(Math.abs(m.averageWin ?? 0))} average win against ${fmt(Math.abs(m.averageLoss ?? 0))} average loss.`,
        ['profitFactor', 'averageWin', 'averageLoss'],
        { profitFactor: m.profitFactor, averageWin: m.averageWin, averageLoss: m.averageLoss },
      ),
    );
  }

  // ── Risk ───────────────────────────────────────────────────────────────
  if (m.maxDrawdownPct >= 20) {
    out.weaknesses.push(
      f(
        `Drawdown reached ${m.maxDrawdownPct}% (${fmt(m.maxDrawdownAmount)}) and the account spent ${m.maxDrawdownDays} days at or below that high-water mark.`,
        ['maxDrawdownPct', 'maxDrawdownAmount', 'maxDrawdownDays'],
        { maxDrawdownPct: m.maxDrawdownPct, maxDrawdownDays: m.maxDrawdownDays },
      ),
    );
  } else if (m.maxDrawdownPct > 0 && m.totalReturnPct > 0 && m.totalReturnPct > m.maxDrawdownPct * 2) {
    out.strengths.push(
      f(
        `Return is ${(m.totalReturnPct / m.maxDrawdownPct).toFixed(1)}x the worst drawdown (${m.maxDrawdownPct}%).`,
        ['totalReturnPct', 'maxDrawdownPct'],
        { totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct },
      ),
    );
  }
  if (m.largestLoss !== null && m.totalPnl !== 0 && Math.abs(m.largestLoss) >= Math.abs(m.totalPnl)) {
    out.failurePatterns.push(
      f(
        `A single trade lost ${fmt(m.largestLoss)} — at least as large as the entire run's result. The outcome rests on one trade.`,
        ['largestLoss', 'totalPnl'],
        { largestLoss: m.largestLoss, totalPnl: m.totalPnl },
      ),
    );
  }

  // ── How trades ended ───────────────────────────────────────────────────
  const exits = m.exitReasons ?? {};
  const exitTotal = Object.values(exits).reduce((s, n) => s + n, 0);
  for (const [reason, count] of Object.entries(exits)) {
    const share = exitTotal ? count / exitTotal : 0;
    if (share < 0.5) continue;
    if (reason === 'STOP') {
      out.failurePatterns.push(
        f(
          `${Math.round(share * 100)}% of trades ended on the stop. Either the entries are early or the stop is inside the instrument's normal noise.`,
          ['exitReasons'],
          { STOP: count, total: exitTotal },
        ),
      );
    } else if (reason === 'TIMEOUT' || reason === 'SESSION_END' || reason === 'SQUARE_OFF') {
      out.failurePatterns.push(
        f(
          `${Math.round(share * 100)}% of trades were closed by the clock (${reason}), not by the plan. The setups are not resolving inside the holding window.`,
          ['exitReasons'],
          { [reason]: count, total: exitTotal },
        ),
      );
    } else if (reason === 'TARGET') {
      out.strengths.push(
        f(`${Math.round(share * 100)}% of trades reached their target.`, ['exitReasons'], {
          TARGET: count,
          total: exitTotal,
        }),
      );
    }
  }

  // ── Regime ─────────────────────────────────────────────────────────────
  out.conditions.push(...regimeFindings(m.regimePerformance ?? [], f));

  // ── Refusals ───────────────────────────────────────────────────────────
  if (m.rejectedSignals > m.totalTrades) {
    out.weaknesses.push(
      f(
        `More signals were refused (${m.rejectedSignals}) than traded (${m.totalTrades}). The risk limits, not the strategy, decided most of this run.`,
        ['rejectedSignals', 'totalTrades', 'refusalReasons'],
        { rejectedSignals: m.rejectedSignals, totalTrades: m.totalTrades },
      ),
    );
  }

  // ── Consistency ────────────────────────────────────────────────────────
  if (m.exposurePct < 5) {
    out.consistency.push(
      f(
        `Capital was deployed for only ${m.exposurePct}% of the tested bars — this is a rare-event strategy, and its results carry the variance that implies.`,
        ['exposurePct'],
        { exposurePct: m.exposurePct },
      ),
    );
  }
  if (m.sharpe !== null) {
    out.consistency.push(
      f(`Sharpe ${m.sharpe}, Sortino ${m.sortino ?? 'n/a'}, annualised volatility ${m.volatilityPct ?? 'n/a'}%.`, [
        'sharpe',
        'sortino',
        'volatilityPct',
      ], { sharpe: m.sharpe, sortino: m.sortino, volatilityPct: m.volatilityPct }),
    );
  }

  return out;
}

function regimeFindings(
  buckets: RegimeBucket[],
  f: (s: string, b: string[], v: Record<string, number | string | null>) => AnalysisFinding,
): AnalysisFinding[] {
  const out: AnalysisFinding[] = [];
  for (const dimension of ['trend', 'volatility'] as const) {
    // Only buckets with a real label and a real sample. An 'unknown' bucket is
    // reported as unknown rather than folded into a conclusion.
    const usable = buckets.filter((b) => b.dimension === dimension && b.label !== 'unknown' && b.trades >= 5);
    if (usable.length < 2) continue;
    const best = usable.reduce((a, b) => (b.netPnl > a.netPnl ? b : a));
    const worst = usable.reduce((a, b) => (b.netPnl < a.netPnl ? b : a));
    if (best.label === worst.label) continue;
    out.push(
      f(
        `Best in ${dimension} = ${best.label} (${best.trades} trades, ${fmt(best.netPnl)}); worst in ${dimension} = ${worst.label} (${worst.trades} trades, ${fmt(worst.netPnl)}).`,
        ['regimePerformance'],
        { best: best.label, bestPnl: best.netPnl, worst: worst.label, worstPnl: worst.netPnl },
      ),
    );
  }
  const unknown = buckets.filter((b) => b.label === 'unknown' && b.trades > 0);
  if (unknown.length) {
    out.push(
      f(
        `${unknown[0].trades} trade(s) have no stored regime classification, so they are excluded from the comparison above rather than assigned to a bucket.`,
        ['regimePerformance'],
        { unclassified: unknown[0].trades },
      ),
    );
  }
  return out;
}

function fmt(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}
