/**
 * Module 12 — Continuous Improvement & Self-Recalibration Loop.
 *
 * Once a session has closed, Sentinel measures itself:
 *
 *  1. **Daily strategy backtesting** — every configured strategy is replayed
 *     bar by bar over the day's candles. The replay calls the *live* engines
 *     (`composeSnapshot` + `StrategyEngineService.scan`), so a strategy is
 *     tested against exactly the structure that would have been detected in
 *     real time. There is no second implementation of the rules to drift.
 *  2. **Performance measurement** — win rate and average forward move per
 *     strategy, broken down by the market profile it fired in, because the
 *     whole point is that a setup can work in a trend and fail in a range.
 *  3. **Confidence weight recalibration** — the Confidence Engine's strategy
 *     factor weight is nudged toward recent measured performance.
 *  4. **Knowledge base refresh** — the vault is re-read so newly added notes
 *     are visible to the ontology; seeding remains the `ontology:seed`
 *     script's job, so this reports rather than duplicates it.
 *  5. **Guidance alignment** — how often a validated setup's stated bias
 *     matched the subsequent move, which is the number that justifies
 *     changing a weight at all.
 *
 * OBSERVATION / EDUCATION ONLY. A replay measures how a rule *would have*
 * behaved on historical bars. It produces statistics; it never produces a
 * live signal and is never wired into the order flow (CLAUDE.md Rule 2).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Candle, MarketDataProvider } from '@tradew/types';
import { OntologyLoaderService } from '../brain/ontology/ontology-loader.service';
import { ConfidenceEngine, ConfidenceFactorName } from '../confidence/confidence.engine';
import { MarketProfileType } from '../domain';
import {
  MARKET_DATA,
  composeSnapshot,
  readOptionChain,
} from '../intelligence/market-intelligence.service';
import { StrategyEngineService } from '../intelligence/strategy-engine.service';

/** Bars to look forward when judging whether a setup followed through. */
const FORWARD_BARS = 8;
/** Move, in percent, below which the forward result is called unclear. */
const MOVE_THRESHOLD_PCT = 0.3;
/** Fewest resolved detections before a measurement may move a weight. */
const MIN_SAMPLE = 8;

export interface StrategyPerformance {
  strategyId: string;
  strategyName: string;
  detections: number;
  resolved: number;
  aligned: number;
  unclear: number;
  opposed: number;
  /** aligned / resolved, or null when the sample is too small to report */
  alignmentRate: number | null;
  avgForwardMovePct: number;
  byProfile: Partial<Record<MarketProfileType, { detections: number; aligned: number }>>;
}

export interface RecalibrationReport {
  symbol: string;
  interval: string;
  from: string;
  to: string;
  barsReplayed: number;
  performance: StrategyPerformance[];
  /** overall aligned / resolved across every strategy */
  guidanceAlignmentRate: number | null;
  weightsBefore: Record<ConfidenceFactorName, number>;
  weightsAfter: Record<ConfidenceFactorName, number>;
  weightsChanged: boolean;
  knowledgeBase: { conceptsFound: number; filesScanned: number; issues: number };
  notes: string[];
}

@Injectable()
export class ContinuousImprovementService {
  private readonly logger = new Logger(ContinuousImprovementService.name);

  constructor(
    @Inject(MARKET_DATA) private readonly marketData: MarketDataProvider,
    private readonly strategies: StrategyEngineService,
    private readonly confidence: ConfidenceEngine,
    private readonly ontology: OntologyLoaderService,
  ) {}

  /**
   * Run the full loop for one symbol over a lookback window.
   * Safe to call repeatedly; it reads history and adjusts weights, nothing else.
   */
  async run(options: { symbol?: string; days?: number; applyRecalibration?: boolean } = {}): Promise<RecalibrationReport> {
    const symbol = options.symbol ?? 'NIFTY';
    const days = options.days ?? 30;
    const apply = options.applyRecalibration !== false;
    const notes: string[] = [];

    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const candles = await this.marketData.getCandles(symbol, '15m', from, to);
    const dayCandles = await this.marketData
      .getCandles(symbol, '1d', new Date(from.getTime() - 5 * 86_400_000), to)
      .catch(() => [] as Candle[]);

    const weightsBefore = { ...this.confidence.activeWeights() };
    const performance = this.replay(symbol, candles, dayCandles, notes);

    const resolved = performance.reduce((s, p) => s + p.resolved, 0);
    const aligned = performance.reduce((s, p) => s + p.aligned, 0);
    const guidanceAlignmentRate = resolved >= MIN_SAMPLE ? aligned / resolved : null;

    let weightsAfter = { ...weightsBefore };
    let weightsChanged = false;
    if (apply && guidanceAlignmentRate !== null) {
      weightsAfter = this.recalibrate(guidanceAlignmentRate, notes);
      weightsChanged = true;
    } else {
      notes.push(
        guidanceAlignmentRate === null
          ? `Only ${resolved} resolved detection(s) across ${days} days — below the ${MIN_SAMPLE}-sample floor, so weights were left alone.`
          : 'Recalibration was requested in report-only mode; weights were left alone.',
      );
    }

    const knowledgeBase = this.refreshKnowledgeBase(notes);

    return {
      symbol,
      interval: '15m',
      from: candles[0]?.timestamp.toISOString() ?? from.toISOString(),
      to: candles[candles.length - 1]?.timestamp.toISOString() ?? to.toISOString(),
      barsReplayed: candles.length,
      performance,
      guidanceAlignmentRate,
      weightsBefore,
      weightsAfter,
      weightsChanged,
      knowledgeBase,
      notes,
    };
  }

  /**
   * Walk the bars, rebuild the snapshot the live engine would have seen at
   * each one, and record what happened next.
   *
   * Look-ahead is avoided structurally: the snapshot at bar `i` is built from
   * `candles.slice(0, i + 1)` only, and the forward outcome is measured from
   * bar `i + 1` onward. Breadth, VIX and the option chain are point-in-time
   * feeds with no history in the provider contract, so they are held null
   * during a replay rather than back-filled with today's values — which would
   * be exactly the look-ahead this design is avoiding.
   */
  private replay(
    symbol: string,
    candles: Candle[],
    dayCandles: Candle[],
    notes: string[],
  ): StrategyPerformance[] {
    const stats = new Map<string, StrategyPerformance>();
    for (const def of this.strategies.getStrategies()) {
      stats.set(def.id, {
        strategyId: def.id,
        strategyName: def.name,
        detections: 0,
        resolved: 0,
        aligned: 0,
        unclear: 0,
        opposed: 0,
        alignmentRate: null,
        avgForwardMovePct: 0,
        byProfile: {},
      });
    }

    // Indicators need history; the strategy rules themselves look back up to
    // 20 bars, so start where both are meaningful.
    const warmup = 50;
    if (candles.length < warmup + FORWARD_BARS + 1) {
      notes.push(`Only ${candles.length} bars available for ${symbol} — too few to replay (needs ${warmup + FORWARD_BARS + 1}).`);
      return [...stats.values()];
    }

    const moveTotals = new Map<string, number[]>();

    for (let i = warmup; i < candles.length - FORWARD_BARS; i++) {
      const history = candles.slice(0, i + 1);
      const bar = candles[i];
      const priorDay = priorDayFor(dayCandles, bar.timestamp);
      const snapshot = composeSnapshot(symbol, history, priorDay, {
        vix: null,
        breadthRatio: null,
        optionChain: readOptionChain([], bar.close),
      });

      const detections = this.strategies.scan(snapshot, bar.timestamp).filter((d) => d.validated);
      if (detections.length === 0) continue;

      const forward = candles[i + FORWARD_BARS];
      const movePct = bar.close !== 0 ? ((forward.close - bar.close) / bar.close) * 100 : 0;

      for (const d of detections) {
        const stat = stats.get(d.strategyId);
        if (!stat) continue;
        stat.detections++;

        const profile = snapshot.marketProfile?.type;
        if (profile) {
          const bucket = stat.byProfile[profile] ?? { detections: 0, aligned: 0 };
          bucket.detections++;
          stat.byProfile[profile] = bucket;
        }

        if (Math.abs(movePct) < MOVE_THRESHOLD_PCT || d.bias === 'neutral') {
          stat.unclear++;
          continue;
        }
        stat.resolved++;
        const moved = movePct > 0 ? 'bullish' : 'bearish';
        if (moved === d.bias) {
          stat.aligned++;
          if (profile) stat.byProfile[profile]!.aligned++;
        } else {
          stat.opposed++;
        }

        const list = moveTotals.get(d.strategyId) ?? [];
        // Signed toward the stated bias, so a bearish setup that fell reads positive.
        list.push(d.bias === 'bearish' ? -movePct : movePct);
        moveTotals.set(d.strategyId, list);
      }
    }

    for (const stat of stats.values()) {
      const moves = moveTotals.get(stat.strategyId) ?? [];
      stat.avgForwardMovePct = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
      stat.alignmentRate = stat.resolved >= MIN_SAMPLE ? stat.aligned / stat.resolved : null;
    }

    return [...stats.values()].sort((a, b) => b.detections - a.detections);
  }

  /**
   * Nudge the Confidence Engine's strategy factor toward measured
   * performance. Deliberately conservative: the weight moves at most a few
   * points per pass and every other weight absorbs the difference through
   * the engine's own normalisation, so one unusual month cannot rewrite the
   * scoring model.
   */
  private recalibrate(alignmentRate: number, notes: string[]): Record<ConfidenceFactorName, number> {
    const current = this.confidence.activeWeights();
    // 0.5 alignment is a coin flip and means the factor deserves less say;
    // 1.0 means it has earned more. ±20% of its own weight is the cap.
    const adjustment = Math.max(-0.2, Math.min(0.2, (alignmentRate - 0.5) * 0.4));
    const target = current.strategy_rules_match * (1 + adjustment);
    const applied = this.confidence.recalibrate({ strategy_rules_match: target });
    notes.push(
      `Strategy-match weight moved from ${current.strategy_rules_match.toFixed(3)} to ${applied.strategy_rules_match.toFixed(3)} on a measured ${(alignmentRate * 100).toFixed(0)}% alignment rate (remaining factors renormalised).`,
    );
    return applied;
  }

  /**
   * Re-read the vault so newly added notes are visible. Writing them into
   * `MemoryRecord` is the `ontology:seed` script's job — this reports what is
   * on disk rather than growing a second seeding path that could disagree
   * with it.
   */
  private refreshKnowledgeBase(notes: string[]): RecalibrationReport['knowledgeBase'] {
    try {
      const result = this.ontology.load();
      if (result.issues.length > 0) {
        notes.push(`Knowledge base has ${result.issues.length} validation issue(s); run \`npm run ontology:validate\` in services/sentinel for detail.`);
      }
      return {
        conceptsFound: result.concepts.length,
        filesScanned: result.filesScanned,
        issues: result.issues.length,
      };
    } catch (err) {
      this.logger.warn(`knowledge base refresh failed: ${err}`);
      notes.push('Knowledge base could not be read on this pass.');
      return { conceptsFound: 0, filesScanned: 0, issues: 0 };
    }
  }
}

/** The most recent completed daily bar strictly before `at`. */
function priorDayFor(dayCandles: Candle[], at: Date): Candle | null {
  let found: Candle | null = null;
  for (const c of dayCandles) {
    if (c.timestamp.toDateString() === at.toDateString()) break;
    if (c.timestamp.getTime() < at.getTime()) found = c;
  }
  return found;
}
