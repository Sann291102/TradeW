/**
 * What the market did next.
 *
 * Walks forward from a candidate's signal bar and decides whether its stop or
 * its target came first, how far it ran in each direction, and what happened
 * after. This is the half of the dataset that turns a prediction into a
 * measurable one — without it, the journal records opinions.
 *
 * ## Shadow positions, not trades
 *
 * Nothing was executed. These outcomes are counterfactual: "if the brain had
 * taken this, here is what it would have got." That is precisely what makes
 * them cheap enough to collect at scale, and it is also why the arithmetic has
 * to be MORE conservative than a real fill would need, not less — an optimistic
 * shadow book is worse than none, because it reads as evidence.
 *
 * ## The pessimistic rules, taken from the backtester rather than reinvented
 *
 * `services/api/src/backtest/execution-simulator.ts` already settled these, and
 * its reasoning applies unchanged. Restating them here would create a second
 * set of conclusions free to drift from the first:
 *
 *   · A bar whose range spans BOTH the stop and the target is a STOP. Nothing
 *     in an OHLC row says which came first, and assuming the target turns a
 *     losing strategy into a winning one on exactly the most volatile bars.
 *   · A bar that GAPS past the stop resolves at that bar's OPEN, not at the
 *     stop — a stop is an instruction, not a guarantee.
 *
 * The one thing deliberately NOT copied is slippage and cost. A shadow outcome
 * measures whether the LEVELS were right; charging modelled costs against a
 * trade that was never placed would blend two questions and make the R-multiple
 * mean neither.
 *
 * ## Rejected candidates are resolved too
 *
 * Deliberately, and it is the most valuable column in the table. A candidate
 * refused for `risk-below-noise-floor` whose levels would have paid 3R is
 * evidence the floor is too high; one refused whose levels would have been
 * stopped is evidence it is doing its job. Only refusals that produced no plan
 * at all are unresolvable, because there is nothing to measure.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type AutonomousOutcomeStatus } from '@prisma/client';
import type { Candle } from '@tradew/types';
import { tradableSpec } from '@tradew/market-data';
import { PrismaService } from '../prisma/prisma.service';
import { MarketDataUnavailable, type MarketDataSource } from './market-data.port';
import { DhanBridgeSource } from './dhan-bridge.source';
import { BinanceSource } from './binance.source';
import { SCAN_INTERVAL } from './setup-scanner.service';

/**
 * How many bars a shadow position is given to reach a level.
 *
 * 96 fifteen-minute bars — a full day of crypto, roughly four Indian sessions.
 * A prediction that has resolved neither way by then has not been proven wrong
 * so much as proven uninformative, and `EXPIRED` records exactly that rather
 * than leaving it open forever and skewing the win rate by omission.
 */
export const HORIZON_BARS = 96;

/** Bars examined AFTER the outcome, to answer "was the level wrong, or the timing?". */
const POST_EXIT_BARS = 20;

/** Days of history to request. Enough to cover the horizon at 15m with slack. */
const LOOKBACK_DAYS = 8;

export interface ResolveSummary {
  examined: number;
  resolved: number;
  stillOpen: number;
  unevaluable: number;
  errors: number;
}

interface Walk {
  status: AutonomousOutcomeStatus;
  exitPrice: number | null;
  barsToOutcome: number | null;
  mfePrice: number | null;
  maePrice: number | null;
  postExitHigh: number | null;
  postExitLow: number | null;
  wouldHaveHitTarget: boolean | null;
  evaluatedThroughAt: Date | null;
}

@Injectable()
export class OutcomeResolverService {
  private readonly logger = new Logger(OutcomeResolverService.name);
  private readonly sources: MarketDataSource[];

  constructor(
    private readonly prisma: PrismaService,
    dhan: DhanBridgeSource,
    binance: BinanceSource,
  ) {
    this.sources = [dhan, binance];
  }

  /**
   * Advance every candidate that has a plan and no settled outcome.
   *
   * Bars are fetched once per symbol and shared across that symbol's
   * candidates — a per-candidate fetch would hammer both providers for data
   * they just returned.
   */
  async resolvePending(limit = 200, now: Date = new Date()): Promise<ResolveSummary> {
    const pending = await this.prisma.autonomousCandidate.findMany({
      where: {
        // Only candidates with levels can be measured at all.
        entry: { not: null },
        stop: { not: null },
        target: { not: null },
        OR: [{ outcome: null }, { outcome: { status: 'UNRESOLVED' } }],
      },
      orderBy: { decidedAt: 'asc' },
      take: limit,
      include: { outcome: { select: { id: true } } },
    });

    const summary: ResolveSummary = {
      examined: pending.length,
      resolved: 0,
      stillOpen: 0,
      unevaluable: 0,
      errors: 0,
    };
    if (pending.length === 0) return summary;

    const bySymbol = new Map<string, typeof pending>();
    for (const c of pending) {
      const list = bySymbol.get(c.symbol) ?? [];
      list.push(c);
      bySymbol.set(c.symbol, list);
    }

    for (const [symbol, candidates] of bySymbol) {
      let bars: Candle[];
      try {
        bars = await this.barsFor(symbol);
      } catch (err) {
        const detail = err instanceof MarketDataUnavailable ? err.message : String(err);
        this.logger.warn(`outcome bars for ${symbol} unavailable: ${detail}`);
        summary.errors += candidates.length;
        continue;
      }

      for (const candidate of candidates) {
        try {
          const walk = this.walk(candidate, bars, now);
          await this.persist(candidate, walk, now);
          if (walk.status === 'UNRESOLVED') summary.stillOpen += 1;
          else if (walk.status === 'UNEVALUABLE') summary.unevaluable += 1;
          else summary.resolved += 1;
        } catch (err) {
          summary.errors += 1;
          this.logger.error(
            `resolve ${candidate.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return summary;
  }

  // ── the walk ─────────────────────────────────────────────────────────────

  /**
   * Replay the bars after the signal bar against the candidate's own levels.
   *
   * Entry is assumed at the candidate's recorded entry price on the bar AFTER
   * the signal bar — never on the signal bar itself, which would be
   * look-ahead: the decision was made from that bar's close, so it could not
   * have been acted on inside it.
   */
  private walk(
    candidate: { signalBarAt: Date | null; direction: string | null; entry: Prisma.Decimal | null; stop: Prisma.Decimal | null; target: Prisma.Decimal | null },
    bars: Candle[],
    now: Date,
  ): Walk {
    const empty: Walk = {
      status: 'UNEVALUABLE',
      exitPrice: null,
      barsToOutcome: null,
      mfePrice: null,
      maePrice: null,
      postExitHigh: null,
      postExitLow: null,
      wouldHaveHitTarget: null,
      evaluatedThroughAt: null,
    };

    if (!candidate.signalBarAt || !candidate.direction || !candidate.entry || !candidate.stop || !candidate.target) {
      return empty;
    }

    const signalMs = candidate.signalBarAt.getTime();
    const startIndex = bars.findIndex((b) => new Date(b.timestamp).getTime() > signalMs);
    if (startIndex === -1) {
      // The feed has not produced a bar after the signal yet. Genuinely open,
      // not unevaluable.
      return { ...empty, status: 'UNRESOLVED' };
    }

    const long = candidate.direction === 'long';
    const stop = Number(candidate.stop);
    const target = Number(candidate.target);
    const window = bars.slice(startIndex, startIndex + HORIZON_BARS);
    const newestAt = new Date(window[window.length - 1]?.timestamp ?? bars[bars.length - 1].timestamp);

    let mfe: number | null = null;
    let mae: number | null = null;

    for (let i = 0; i < window.length; i += 1) {
      const bar = window[i];
      // Excursions are updated BEFORE the exit test, so the bar that resolves
      // the trade still contributes its extremes — otherwise a trade that hit
      // its target would report an MFE short of the target it reached.
      mfe = mfe === null ? (long ? bar.high : bar.low) : long ? Math.max(mfe, bar.high) : Math.min(mfe, bar.low);
      mae = mae === null ? (long ? bar.low : bar.high) : long ? Math.min(mae, bar.low) : Math.max(mae, bar.high);

      // Stop first, always — the pessimistic reading of an ambiguous bar.
      const gapped = long ? bar.open <= stop : bar.open >= stop;
      const stopped = long ? bar.low <= stop : bar.high >= stop;
      if (gapped || stopped) {
        const exit = gapped ? bar.open : stop;
        const after = window.slice(i + 1, i + 1 + POST_EXIT_BARS);
        const reached = after.some((b) => (long ? b.high >= target : b.low <= target));
        return {
          status: 'STOP_HIT',
          exitPrice: exit,
          barsToOutcome: i + 1,
          mfePrice: mfe,
          maePrice: mae,
          postExitHigh: after.length ? Math.max(...after.map((b) => b.high)) : null,
          postExitLow: after.length ? Math.min(...after.map((b) => b.low)) : null,
          wouldHaveHitTarget: after.length ? reached : null,
          evaluatedThroughAt: newestAt,
        };
      }

      const gappedTarget = long ? bar.open >= target : bar.open <= target;
      const hitTarget = long ? bar.high >= target : bar.low <= target;
      if (gappedTarget || hitTarget) {
        const exit = gappedTarget ? bar.open : target;
        const after = window.slice(i + 1, i + 1 + POST_EXIT_BARS);
        return {
          status: 'TARGET_HIT',
          exitPrice: exit,
          barsToOutcome: i + 1,
          mfePrice: mfe,
          maePrice: mae,
          postExitHigh: after.length ? Math.max(...after.map((b) => b.high)) : null,
          postExitLow: after.length ? Math.min(...after.map((b) => b.low)) : null,
          wouldHaveHitTarget: null,
          evaluatedThroughAt: newestAt,
        };
      }
    }

    // Neither level reached. Only EXPIRED once the full horizon has actually
    // been observed — before that it is still running, and calling it expired
    // early would count live predictions as failures.
    const expired = window.length >= HORIZON_BARS;
    return {
      status: expired ? 'EXPIRED' : 'UNRESOLVED',
      exitPrice: expired ? window[window.length - 1].close : null,
      barsToOutcome: expired ? window.length : null,
      mfePrice: mfe,
      maePrice: mae,
      postExitHigh: null,
      postExitLow: null,
      wouldHaveHitTarget: null,
      evaluatedThroughAt: newestAt,
    };
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private async persist(
    candidate: { id: string; entry: Prisma.Decimal | null; stop: Prisma.Decimal | null; direction: string | null; signalBarAt: Date | null },
    walk: Walk,
    now: Date,
  ): Promise<void> {
    const entry = candidate.entry ? Number(candidate.entry) : null;
    const risk = entry !== null && candidate.stop ? Math.abs(entry - Number(candidate.stop)) : null;
    const long = candidate.direction === 'long';

    /** Signed move in units of initial risk. Null when risk is unmeasurable. */
    const rOf = (price: number | null): number | null => {
      if (price === null || entry === null || !risk) return null;
      const move = long ? price - entry : entry - price;
      return Number((move / risk).toFixed(3));
    };

    const secondsToOutcome =
      walk.barsToOutcome !== null ? walk.barsToOutcome * 15 * 60 : null;

    const data = {
      status: walk.status,
      evaluatedAt: now,
      evaluatedThroughAt: walk.evaluatedThroughAt,
      resolvedAt: walk.status === 'UNRESOLVED' || walk.status === 'UNEVALUABLE' ? null : now,
      barsToOutcome: walk.barsToOutcome,
      secondsToOutcome,
      exitPrice: this.decimal(walk.exitPrice),
      actualR: this.decimal(rOf(walk.exitPrice)),
      mfePrice: this.decimal(walk.mfePrice),
      maePrice: this.decimal(walk.maePrice),
      mfeR: this.decimal(rOf(walk.mfePrice)),
      maeR: this.decimal(rOf(walk.maePrice)),
      postExitHigh: this.decimal(walk.postExitHigh),
      postExitLow: this.decimal(walk.postExitLow),
      wouldHaveHitTarget: walk.wouldHaveHitTarget,
      unevaluableReason:
        walk.status === 'UNEVALUABLE' ? 'No bar after the signal bar could be obtained.' : null,
    };

    // Upsert on the OUTCOME, never a write back onto the candidate. The
    // candidate's decision-time columns stay exactly as the brain wrote them.
    await this.prisma.autonomousOutcome.upsert({
      where: { candidateId: candidate.id },
      create: { candidateId: candidate.id, ...data },
      update: data,
    });
  }

  private async barsFor(symbol: string): Promise<Candle[]> {
    const spec = tradableSpec(symbol);
    if (!spec) throw new MarketDataUnavailable(symbol, 'resolver', 'not in the tradable universe');
    const source = this.sources.find((s) => s.markets.includes(spec.market));
    if (!source) throw new MarketDataUnavailable(symbol, 'resolver', `no source for ${spec.market}`);
    const read = await source.read(symbol, SCAN_INTERVAL, LOOKBACK_DAYS);
    return read.candles;
  }

  private decimal(value: number | null): Prisma.Decimal | null {
    return value === null || value === undefined || Number.isNaN(value)
      ? null
      : new Prisma.Decimal(value);
  }
}
