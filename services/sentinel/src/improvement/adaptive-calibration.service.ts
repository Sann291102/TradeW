import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isMarketOpen, isTradingDay } from '../market-clock';
import { ContinuousImprovementService } from './continuous-improvement.service';

/**
 * Adaptive calibration — Phase 4.
 *
 * Sentinel already had every piece of a learning loop and no loop:
 * `PatternRecognitionService` recorded occurrences, `OutcomeLearningService`
 * tagged them 15 minutes later, `ContinuousImprovementService.run()` measured
 * alignment and called `ConfidenceEngine.recalibrate()` — but `run()` was
 * reachable only from an HTTP endpoint (`app.controller.ts`), so unless an
 * operator called it by hand, nothing ever recalibrated. "Adaptive confidence"
 * was adaptive by design and static in fact.
 *
 * This service closes the loop in two ways:
 *
 *  1. **It runs the improvement pass on a schedule**, once per day after the
 *     close, instead of waiting for a human.
 *  2. **It calibrates per (regime, strategy)** rather than adjusting one
 *     global factor. Master Plan Module 12's own worked example is that "ORB
 *     retests work well in trending markets, poorly in range markets" — a
 *     single global weight cannot express that, and averaging the two makes
 *     the strategy look mediocre everywhere instead of good somewhere.
 *
 * ## What adapts, and what must never
 *
 * Factor weights and per-strategy reliability adapt. **The publication
 * threshold does not** — see `publication-gate.ts`. A system that can move its
 * own bar can quietly lower it, and no audit of a past observation could then
 * say what bar it cleared. This service has no access to the threshold by
 * construction: it never imports it.
 *
 * ## ⚠️ SINGLE REPLICA ONLY — deployment constraint
 *
 * Calibration state lives in this process's memory (`this.calibrations`) and
 * the once-per-day guard is a process-local field (`lastRunDate`). Running two
 * replicas therefore breaks this service in two distinct ways:
 *
 *  1. **The daily pass runs once per replica**, so `ContinuousImprovementService`
 *     applies its weight adjustment N times for an N-replica deploy — and the
 *     adjustment compounds, because each pass reads the weights the previous
 *     one wrote.
 *  2. **Replicas diverge**, so two observations of the same symbol seconds
 *     apart can be scored with different weights depending on which replica
 *     answered, with nothing in either response saying so.
 *
 * This is the same constraint `services/market-data`'s README declares for the
 * ingestor, for a different reason. Moving the calibration store and the
 * run-guard into Postgres is the change to make before scaling out; until then
 * `services/sentinel` must run as a single instance.
 *
 * ## Why reliability is a multiplier, not a veto
 *
 * A strategy performing badly in the current regime lowers its confidence
 * contribution; it never suppresses the detection outright. Suppression would
 * hide the setup from the timeline and from the trader's own judgement, and
 * would starve the very outcome record that would let it recover — a strategy
 * silenced for underperforming can never demonstrate it stopped.
 */

/** Outcomes counted as the setup having worked. */
const SUCCESS_OUTCOMES = ['followed_through', 'target_reached', 'success'];
/** Outcomes counted as the setup having failed. */
const FAILURE_OUTCOMES = ['failed', 'invalidated', 'reversed'];

/**
 * Occurrences required before a (regime, strategy) pair earns a calibration.
 *
 * Reuses the Brain's existing floor rather than inventing a second one:
 * `StrategyIntelligenceService.MIN_SAMPLE` and the live-performance gate both
 * use 8, and a third independently-tuned threshold would be a third answer to
 * one question, drifting apart silently.
 */
export const MIN_CALIBRATION_SAMPLE = 8;

/**
 * How far reliability may move a strategy's confidence contribution.
 *
 * ±25%: enough that a strategy which genuinely does not work in a regime stops
 * dominating the score, bounded so that one unusual fortnight cannot rewrite
 * the model. The engine's own weight normalisation absorbs the difference.
 */
export const MAX_RELIABILITY_ADJUSTMENT = 0.25;

export interface StrategyCalibration {
  strategyId: string;
  regime: string;
  sample: number;
  successes: number;
  failures: number;
  /** 0..1 — measured success share. Null until the sample floor is cleared. */
  successRate: number | null;
  /** Multiplier applied to this strategy's confidence contribution. 1 = neutral. */
  reliability: number;
  /** Why the multiplier is what it is — always populated. */
  rationale: string;
}

@Injectable()
export class AdaptiveCalibrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdaptiveCalibrationService.name);

  /** `regime::strategyId` → calibration. */
  private calibrations = new Map<string, StrategyCalibration>();
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: Date | null = null;
  private runs = 0;
  /** IST date string of the last completed daily pass, so it runs once a day. */
  private lastRunDate: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly improvement: ContinuousImprovementService,
  ) {}

  onModuleInit(): void {
    if (process.env.SENTINEL_ADAPTIVE_CALIBRATION === 'false') {
      this.logger.log('adaptive calibration disabled (SENTINEL_ADAPTIVE_CALIBRATION=false)');
      return;
    }
    // Raw `setInterval` under the lifecycle hooks, matching
    // `MarketWatchService` and `IngestionQueueService`. `@nestjs/schedule` is
    // deliberately absent repo-wide: it runs a job once per replica, and a
    // recalibration that ran N times per day on an N-replica deploy would
    // apply its adjustment N times.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.log('adaptive calibration ready — daily pass after market close');
    // Warm the cache from whatever the Brain already holds, so the first
    // observation after a restart is calibrated rather than neutral.
    void this.refresh().catch((err) => this.logger.warn(`initial calibration refresh failed: ${err}`));
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Once per day, after the close.
   *
   * Deliberately not during the session: the improvement pass replays candles
   * and rewrites scoring weights, and doing that mid-session would mean two
   * observations minutes apart were scored by different models with nothing in
   * either response saying so.
   */
  private async tick(): Promise<void> {
    const now = new Date();
    const decision = shouldRunDailyPass(now, this.lastRunDate);
    if (!decision.run) return;

    this.lastRunDate = decision.istDate;
    try {
      await this.runDailyPass();
    } catch (err) {
      this.logger.error(`daily calibration pass failed: ${err}`);
      // Allow a retry later today rather than losing the day entirely.
      this.lastRunDate = null;
    }
  }

  /**
   * The daily pass: recalibrate factor weights, then refresh per-strategy
   * reliability from the day's newly outcome-tagged occurrences.
   */
  async runDailyPass(): Promise<{ calibrations: StrategyCalibration[]; improvementNotes: string[] }> {
    this.logger.log('running daily adaptive calibration pass');
    const report = await this.improvement.run({ applyRecalibration: true });
    const calibrations = await this.refresh();
    this.lastRunAt = new Date();
    this.runs++;
    this.logger.log(
      `calibration pass complete — ${calibrations.length} (regime, strategy) pairs calibrated`,
    );
    return { calibrations, improvementNotes: report.notes ?? [] };
  }

  /**
   * Recompute reliability for every (regime, strategy) pair from the Brain's
   * outcome-tagged occurrences.
   *
   * Reads `MemoryRecord` directly rather than going through
   * `StrategyIntelligenceService.baseRateFor`, because that method answers for
   * ONE pattern across all regimes and this needs the whole set split BY
   * regime — calling it per pattern would re-scan the table once per strategy.
   */
  async refresh(): Promise<StrategyCalibration[]> {
    try {
      const rows = await this.prisma.memoryRecord.findMany({
        where: { tags: { has: 'pattern_occurrence' }, namespace: 'sentinel' },
        select: { metadata: true },
      });

      const buckets = new Map<string, { successes: number; failures: number; strategyId: string; regime: string }>();
      for (const row of rows) {
        const meta = row.metadata as { pattern?: string; outcome?: string | null; regime?: string | null } | null;
        if (!meta?.pattern || !meta.outcome) continue;
        // Occurrences recorded before regime tagging existed are bucketed as
        // 'unknown' rather than dropped — they are still real outcomes, and
        // discarding history to keep a new dimension tidy loses evidence.
        const regime = meta.regime ?? 'unknown';
        const key = `${regime}::${meta.pattern}`;
        const bucket = buckets.get(key) ?? { successes: 0, failures: 0, strategyId: meta.pattern, regime };
        if (SUCCESS_OUTCOMES.includes(meta.outcome)) bucket.successes++;
        else if (FAILURE_OUTCOMES.includes(meta.outcome)) bucket.failures++;
        // Any other outcome (e.g. 'unclear') is counted in neither: it is not
        // evidence the setup worked, and not evidence it failed.
        buckets.set(key, bucket);
      }

      const next = new Map<string, StrategyCalibration>();
      for (const [key, bucket] of buckets) {
        next.set(key, calibrationFrom(bucket));
      }
      this.calibrations = next;
      return [...next.values()];
    } catch (err) {
      // A Brain outage leaves the previous calibration in place rather than
      // resetting every strategy to neutral — stale calibration is closer to
      // the truth than no calibration.
      this.logger.warn(`calibration refresh failed, keeping previous values: ${err}`);
      return [...this.calibrations.values()];
    }
  }

  /**
   * The reliability multiplier for a strategy in the current regime.
   *
   * Falls back through regime-specific → cross-regime → neutral, so a strategy
   * with a long record overall but none yet in today's regime is not treated
   * as unknown.
   */
  reliabilityFor(strategyId: string, regime: string | null): StrategyCalibration | null {
    const pattern = strategyId.replace(/-/g, '_');
    if (regime) {
      const exact = this.calibrations.get(`${regime}::${pattern}`);
      if (exact && exact.successRate !== null) return exact;
    }
    const across = this.aggregateAcrossRegimes(pattern);
    return across;
  }

  /** Pooled record for a strategy across every regime. */
  private aggregateAcrossRegimes(pattern: string): StrategyCalibration | null {
    let successes = 0;
    let failures = 0;
    for (const [key, cal] of this.calibrations) {
      if (!key.endsWith(`::${pattern}`)) continue;
      successes += cal.successes;
      failures += cal.failures;
    }
    if (successes + failures === 0) return null;
    return calibrationFrom({ successes, failures, strategyId: pattern, regime: 'all' });
  }

  /** State for the operator endpoint. */
  status() {
    return {
      enabled: this.timer !== null,
      runs: this.runs,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastRunDate: this.lastRunDate,
      calibrations: [...this.calibrations.values()].sort((a, b) => b.sample - a.sample),
    };
  }
}

/**
 * Turn a success/failure tally into a bounded reliability multiplier.
 *
 * Exported and pure so the arithmetic is testable without a database — this is
 * the number that changes what a trader sees, and it must be verifiable.
 */
export function calibrationFrom(bucket: {
  successes: number;
  failures: number;
  strategyId: string;
  regime: string;
}): StrategyCalibration {
  const sample = bucket.successes + bucket.failures;
  const base: Omit<StrategyCalibration, 'successRate' | 'reliability' | 'rationale'> = {
    strategyId: bucket.strategyId,
    regime: bucket.regime,
    sample,
    successes: bucket.successes,
    failures: bucket.failures,
  };

  if (sample < MIN_CALIBRATION_SAMPLE) {
    return {
      ...base,
      successRate: null,
      reliability: 1,
      rationale:
        `${sample} outcome-tagged occurrence${sample === 1 ? '' : 's'} in the ${bucket.regime} regime — ` +
        `below the ${MIN_CALIBRATION_SAMPLE}-sample floor, so no adjustment is applied.`,
    };
  }

  const successRate = bucket.successes / sample;
  // 0.5 is a coin flip and earns no adjustment either way; the multiplier
  // scales linearly out to the cap at 0 and 1.
  const reliability = 1 + Math.max(-1, Math.min(1, (successRate - 0.5) * 2)) * MAX_RELIABILITY_ADJUSTMENT;

  return {
    ...base,
    successRate: Number(successRate.toFixed(3)),
    reliability: Number(reliability.toFixed(3)),
    rationale:
      `${bucket.successes} of ${sample} occurrences followed through in the ${bucket.regime} regime ` +
      `(${(successRate * 100).toFixed(0)}%), so this strategy's confidence contribution is scaled by ` +
      `${reliability.toFixed(2)}×.`,
  };
}

/**
 * Should the daily pass run at this moment?
 *
 * Extracted as a pure predicate so the schedule is verifiable without waiting
 * on a 15-minute timer. A background job whose trigger condition can only be
 * exercised by real elapsed time is a job nobody tests — the same reasoning
 * that made `MarketWatchService.sweep()` public.
 *
 * Returns the IST date alongside the decision so the caller records exactly
 * the day it just ran for, rather than recomputing it and risking a
 * midnight-boundary disagreement between the two calls.
 */
export function shouldRunDailyPass(
  now: Date,
  lastRunDate: string | null,
): { run: boolean; istDate: string; reason: string } {
  const istDate = istDateString(now);
  if (lastRunDate === istDate) {
    return { run: false, istDate, reason: 'already ran today' };
  }
  if (!isTradingDay(now)) {
    // A weekend or NSE holiday produced no observations and therefore no
    // outcomes, so a pass here would recalibrate on the previous session's
    // sample a second time. Before clock unification this was unreachable in
    // practice for the wrong reason — `isMarketOpen` returned true at 11:00 on
    // a Saturday, so the branch below caught it — and it ran anyway after
    // 15:30. Checked explicitly now that the clock is honest.
    return { run: false, istDate, reason: 'not a trading day' };
  }
  if (isMarketOpen(now)) {
    // Rewriting scoring weights mid-session would mean two observations
    // minutes apart were scored by different models, with nothing in either
    // response saying so.
    return { run: false, istDate, reason: 'market is open' };
  }
  if (istMinutesOfDay(now) < MARKET_CLOSE_MIN) {
    // Before the open, not after the close — today's outcomes do not exist yet.
    return { run: false, istDate, reason: 'before the close' };
  }
  return { run: true, istDate, reason: 'after the close and not yet run today' };
}

const TICK_MS = 15 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** 15:30 IST in minutes from midnight. */
const MARKET_CLOSE_MIN = 15 * 60 + 30;

function istDateString(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinutesOfDay(at: Date): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
