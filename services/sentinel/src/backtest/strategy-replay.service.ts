import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Candle } from '@tradew/types';
import { SNAPSHOT_LOOKBACK_MS, composeSnapshot } from '../intelligence/market-intelligence.service';
import { StrategyDefinition, StrategyEngineService } from '../intelligence/strategy-engine.service';
import { istDateKey } from '../market-clock';
import { WARMUP_BARS } from './historical-bars';
import type { ReplayContext, ReplaySignal } from './replay-contract';

/**
 * Walks historical bars and reports where the trader's strategies fired.
 *
 * ## The one rule this file exists to enforce: no look-ahead
 *
 * At bar `i` the strategy may see bars `0..i` and nothing else. That is not a
 * convention here, it is the construction — `windowFor` returns a slice whose
 * upper bound is `i`, `composeSnapshot` is a pure function of what it is
 * handed, and no future bar is in scope anywhere in this file. There is no
 * "remember not to peek" discipline to forget, because there is nothing to peek
 * at.
 *
 * Three subtler leaks that a slice alone does NOT close, and are closed here:
 *
 *   1. THE FILL BAR. A signal is detected at the CLOSE of bar i. Filling on
 *      that same close means trading a price you needed in order to know you
 *      wanted to trade. `nextBarIndex` names bar i+1 — and is null when i is
 *      the last bar of its session or of the window, because then there is no
 *      honest fill and the caller must skip rather than reach across the gap.
 *   2. THE SCAN CLOCK. `StrategyEngineService.scan(snapshot, at)` gates
 *      `idealSession` on `at`. Passing the wall clock would let a 2026-05 bar
 *      be judged against today's time of day. `at` is the bar's own timestamp.
 *   3. THE PRIOR DAY. `composeSnapshot` derives CPR from the prior daily bar.
 *      Handing it the newest daily bar in the file would hand a 09:20 decision
 *      the pivot computed from a day that has not happened. It gets the newest
 *      daily bar STRICTLY BEFORE the replayed bar's own IST date.
 *
 * ## Why the lookback is bounded, and bounded to exactly five days
 *
 * The live path (`MarketIntelligenceService.snapshot`) reads
 * `SNAPSHOT_LOOKBACK_MS` of history, not all of it. A replay that fed the
 * strategy every bar since the beginning of the backfill would compute EMA(50)
 * over a window the live engine never sees, and the two would disagree about
 * the same market — a backtest that measures a strategy the product does not
 * run. The same constant is imported rather than repeated, so the two cannot
 * drift apart later.
 *
 * It is also what keeps the walk linear rather than quadratic, but that is the
 * side effect, not the reason.
 *
 * ## What is honestly different from live, and cannot be fixed here
 *
 * Live snapshots carry `vix`, `breadthRatio` and an option chain. None of the
 * three is stored historically, so all three are null in a replay. That is
 * safe today for a specific, checked reason: no rule in `strategy-rules.ts`
 * reads any of them — every rule is a pure function of price, volume and
 * structure. If a future rule starts reading one, this file must start
 * refusing to replay that strategy rather than quietly scoring it against
 * nulls. `UNAVAILABLE_SNAPSHOT_INPUTS` names them so that check has something
 * to key on.
 *
 * The other honest difference: live sees a FORMING newest bar, a replay sees a
 * closed one. Nothing can recover the intra-bar path from an OHLC row, and
 * inventing one would be fabrication.
 */

/** Snapshot inputs that have no historical store. See the note above. */
export const UNAVAILABLE_SNAPSHOT_INPUTS = ['vix', 'breadthRatio', 'optionChain'] as const;

export interface ReplayInput {
  symbol: string;
  /** Ascending, complete bars for the requested window. */
  bars: Candle[];
  /** Ascending daily bars covering the window and at least one day before it. */
  dailyBars: Candle[];
  strategyId: string | null;
  minConfidence: number;
  includeUnvalidated: boolean;
}

export interface ReplayOutput {
  signals: ReplaySignal[];
  warmupBars: number;
  considered: { id: string; name: string; version: string }[];
  strategyVersion: string;
}

@Injectable()
export class StrategyReplayService {
  private readonly logger = new Logger(StrategyReplayService.name);

  constructor(private readonly strategies: StrategyEngineService) {}

  replay(input: ReplayInput): ReplayOutput {
    const { bars, dailyBars, symbol, strategyId, minConfidence, includeUnvalidated } = input;

    const considered = this.resolveStrategies(strategyId);
    const strategyVersion = hashDefinitions(considered.definitions);
    const allowed = new Set(considered.definitions.map((d) => d.id));

    const signals: ReplaySignal[] = [];
    const warmup = Math.min(WARMUP_BARS, bars.length);
    if (bars.length <= warmup) {
      return { signals, warmupBars: bars.length, considered: considered.summary, strategyVersion };
    }

    // Session boundaries, precomputed once. A signal on the last bar of a
    // session has no next-bar fill inside that session, and reaching into the
    // next session's open would be a fill nobody could have got.
    const sessionKeys = bars.map((b) => istDateKey(b.timestamp));

    let windowStart = 0;
    for (let i = warmup; i < bars.length; i++) {
      const bar = bars[i];
      const at = bar.timestamp;

      // Advance the lower bound instead of re-scanning from zero: the bound is
      // monotone in i, so this is O(n) across the whole walk.
      const floor = at.getTime() - SNAPSHOT_LOOKBACK_MS;
      while (windowStart < i && bars[windowStart].timestamp.getTime() < floor) windowStart++;

      const view = bars.slice(windowStart, i + 1);
      const priorDay = priorDailyBar(dailyBars, sessionKeys[i]);

      const snapshot = composeSnapshot(symbol, view, priorDay, {
        vix: null,
        breadthRatio: null,
        optionChain: null,
      });

      const detections = this.strategies.scan(snapshot, at);
      const best = detections
        .filter((d) => allowed.has(d.strategyId))
        .filter((d) => (includeUnvalidated ? true : d.validated))
        .filter((d) => d.confidence >= minConfidence)
        .filter((d) => d.bias === 'bullish' || d.bias === 'bearish')[0];
      if (!best) continue;

      const nextIsSameSession = i + 1 < bars.length && sessionKeys[i + 1] === sessionKeys[i];
      signals.push({
        barIndex: i,
        nextBarIndex: nextIsSameSession ? i + 1 : null,
        at: at.toISOString(),
        strategyId: best.strategyId,
        strategyName: best.strategyName,
        strategyVersion: hashDefinitions(considered.definitions.filter((d) => d.id === best.strategyId)),
        confidence: best.confidence,
        bias: best.bias,
        validated: best.validated,
        rulesMatched: best.rulesMatched,
        rulesUnmet: best.rulesUnmet,
        invalidationsTriggered: best.invalidationsTriggered,
        context: extractContext(snapshot),
      });
    }

    return { signals, warmupBars: warmup, considered: considered.summary, strategyVersion };
  }

  /**
   * Which strategies may fire. An unknown id is an error, not an empty result:
   * a backtest that silently considers nothing produces "this strategy never
   * fires", which is the same output as a strategy that genuinely never fires.
   */
  private resolveStrategies(strategyId: string | null): {
    definitions: StrategyDefinition[];
    summary: { id: string; name: string; version: string }[];
  } {
    const all = this.strategies.getStrategies().filter((s) => s.enabled);
    const definitions = strategyId ? all.filter((s) => s.id === strategyId) : all;
    if (strategyId && definitions.length === 0) {
      throw new Error(`Unknown or disabled strategy "${strategyId}".`);
    }
    return {
      definitions,
      summary: definitions.map((d) => ({ id: d.id, name: d.name, version: hashDefinitions([d]) })),
    };
  }
}

/**
 * The newest daily bar STRICTLY BEFORE `sessionKey`.
 *
 * Strictly, because the same day's daily bar contains that day's high, low and
 * close — handing it to a 09:20 decision is the purest form of look-ahead this
 * engine could commit, and it would silently improve every CPR strategy.
 */
export function priorDailyBar(dailyBars: Candle[], sessionKey: string): Candle | null {
  let found: Candle | null = null;
  for (const d of dailyBars) {
    if (istDateKey(d.timestamp) >= sessionKey) break;
    found = d;
  }
  return found;
}

/**
 * A stable identity for a strategy's rule set.
 *
 * Only the fields that change what the strategy DOES are hashed. `name` is
 * excluded deliberately: renaming a strategy must not invalidate the
 * comparability of two results that tested identical rules.
 */
export function hashDefinitions(defs: StrategyDefinition[]): string {
  const canonical = defs
    .map((d) => ({
      id: d.id,
      rules: [...d.rules].sort(),
      invalidations: [...d.invalidations].sort(),
      idealSession: d.idealSession ?? null,
      baseConfidenceWeight: d.baseConfidenceWeight,
      biasSource: d.biasSource,
      source: d.source,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/**
 * The market context a signal fired in — copied off the snapshot, never
 * inferred. Every field is null when the snapshot could not derive it, which is
 * the honest answer and the one the UI renders as "not available".
 */
export function extractContext(snapshot: ReturnType<typeof composeSnapshot>): ReplayContext {
  return {
    lastPrice: snapshot.lastPrice,
    rsi14: snapshot.rsi14,
    ema20: snapshot.ema20,
    ema50: snapshot.ema50,
    vwap: snapshot.vwap,
    support: snapshot.support,
    resistance: snapshot.resistance,
    volumeVsAvg: snapshot.volumeVsAvg,
    realizedVolPct: snapshot.realizedVolPct,
    dayType: snapshot.marketProfile?.type ?? null,
    trend: snapshot.trendAnalysis?.direction ?? null,
    // The regime label is the snapshot's OWN classification, not a threshold
    // invented here — `classifyProfile` already decided it from the same bars.
    volatilityRegime: snapshot.marketProfile?.volatility ?? null,
  };
}
