/**
 * The api→sentinel wire contract for a historical strategy replay.
 *
 * ## Why the split is here and not somewhere else
 *
 * A backtest needs two things this codebase already owns, in two different
 * services, and neither may be duplicated:
 *
 *   · the STRATEGY — `StrategyEngineService` + `composeSnapshot` + the
 *     indicator wiring, all of which live in `services/sentinel` and are the
 *     same objects the live `/observe` path uses;
 *   · the MONEY — margin, charges, fills and portfolio accounting, which live
 *     in `services/api/src/sim` and are the same objects the paper engine uses.
 *
 * So sentinel answers exactly one question — "at which bars did this strategy
 * fire, and what did the market look like there" — and `services/api` decides
 * what a portfolio would have done about it. Neither half re-implements the
 * other, which is the whole point: a backtest that drifts from the live
 * strategy measures nothing.
 *
 * ## One call, not one call per bar
 *
 * The paper loop calls `POST /execution/evaluate` once per tick because it has
 * one decision to make. A replay has one per bar — thousands — so the same
 * shape would be thousands of round trips for a single backtest. The whole
 * window is walked here and returned once.
 *
 * ## This is a READ, and it is not a recommendation
 *
 * Sentinel still cannot write an order, and nothing below names a contract to
 * buy. A signal is "strategy X confirmed at bar T with bias B" — the same
 * observation `/observe` already publishes, evaluated against past bars. What
 * to do about it is the caller's arithmetic, and its output is a historical
 * statistic, never a live instruction (CLAUDE.md Rule 2).
 */

import type { CandleInterval } from '@tradew/types';

export interface BacktestScanRequest {
  symbol: string;
  timeframe: CandleInterval;
  /** Inclusive ISO bounds of the requested window. */
  startAt: string;
  endAt: string;
  /**
   * A specific `StrategyEngineService` id, or null to consider every enabled
   * strategy and report the strongest validated detection per bar. Null is the
   * same 'auto' mode `ExecutionProfile.strategyId` uses.
   */
  strategyId: string | null;
  /**
   * Confidence floor (0-100) a detection must clear to be reported as a signal.
   * Mirrors `ExecutionProfile.minConfidence`, so a replay and the paper loop
   * apply the same threshold to the same numbers.
   */
  minConfidence: number;
  /**
   * When false, only fully-validated detections (every rule confirmed, nothing
   * invalidated) become signals — the same set `StrategyEngineService.validated`
   * returns and the Confidence Engine scores on. Defaults to false.
   */
  includeUnvalidated?: boolean;
}

/** One replayed bar, exactly as stored. */
export interface ReplayBar {
  /** Bar OPEN time, UTC ISO — bars are addressed by their opening instant. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Open interest at bar close; absent for cash and index instruments. */
  oi?: number;
}

/**
 * A strategy detection at one bar.
 *
 * `barIndex` refers to `BacktestScanResponse.bars`, and it is the bar whose
 * CLOSE produced the detection. A caller must not fill on that bar — see
 * `nextBarIndex`, which is null when the signal fired on the last bar of a
 * session or of the whole window and therefore has no honest fill bar at all.
 */
export interface ReplaySignal {
  barIndex: number;
  /** Index of the bar a fill may be taken on, or null when there is none. */
  nextBarIndex: number | null;
  at: string;
  strategyId: string;
  strategyName: string;
  strategyVersion: string;
  confidence: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  validated: boolean;
  rulesMatched: string[];
  rulesUnmet: string[];
  invalidationsTriggered: string[];
  /**
   * The market context this detection was made in, read off the same snapshot
   * the rules were evaluated against. Every field is null when the snapshot
   * could not derive it — nothing here is inferred or filled in.
   */
  context: ReplayContext;
}

export interface ReplayContext {
  lastPrice: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  support: number | null;
  resistance: number | null;
  volumeVsAvg: number | null;
  realizedVolPct: number | null;
  /** MarketProfile's day type, when Module 1 could classify it. */
  dayType: string | null;
  /** TrendAnalysis direction for the session. */
  trend: string | null;
  /** Derived from realizedVolPct against its own window: 'low' | 'normal' | 'high'. */
  volatilityRegime: string | null;
}

/** What the requested window actually contained. Never smoothed over. */
export interface ReplayCoverage {
  requestedFrom: string;
  requestedTo: string;
  /** Null when no bar at all was found. */
  firstBarAt: string | null;
  lastBarAt: string | null;
  barCount: number;
  /** Distinct IST trading dates that produced at least one bar. */
  sessionCount: number;
  /**
   * Provenance of the bars actually read, from `Candle.source` — 'dhan',
   * 'nse-bhavcopy', or a comma-joined list when the window spans more than one.
   */
  source: string | null;
  /**
   * Identity of this bar set: the newest `Candle.createdAt` in the window and
   * the row count. A backfill that adds or repairs bars moves it, which is what
   * makes "same configuration, different result" explainable.
   */
  dataVersion: string | null;
  /** IST dates inside the window that are trading days but produced no bar. */
  missingSessions: string[];
  /**
   * Holes INSIDE a session: a gap between consecutive bars larger than the
   * timeframe, with the count of bars missing. The engine reports these; it
   * never fills them.
   */
  intraSessionGaps: { after: string; before: string; missingBars: number }[];
  /** True when the instrument resolved but has no bars in the window at all. */
  empty: boolean;
}

export interface BacktestScanResponse {
  symbol: string;
  exchange: string;
  /** Null when the symbol resolved to no Instrument row. */
  instrumentId: string | null;
  instrumentType: string | null;
  lotSize: number;
  timeframe: CandleInterval;
  coverage: ReplayCoverage;
  bars: ReplayBar[];
  signals: ReplaySignal[];
  /**
   * Content hash of every strategy definition that was allowed to fire. Changes
   * when a rule set changes, so a result can name the exact strategy it tested.
   */
  strategyVersion: string;
  /** Strategy ids considered, resolved from the request. */
  strategiesConsidered: { id: string; name: string; version: string }[];
  /**
   * How many bars were walked but could not produce a detection because the
   * indicators were still warming up. Reported so a short window cannot look
   * like a strategy that never fires.
   */
  warmupBars: number;
  scanVersion: string;
}
