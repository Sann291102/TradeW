import type { Candle } from '@tradew/types';
import type { MarketSnapshot } from '../../intelligence/market-intelligence.service';
import {
  findFairValueGaps,
  findFibonacci,
  findLevels,
  findLiquidityPools,
  findSwings,
  findTrendLines,
  findZones,
  type FairValueGap,
  type FibonacciLevels,
  type LiquidityPool,
  type PriceLevel,
  type SwingPoint,
  type TrendLine,
  type Zone,
} from './geometry';
import {
  atr,
  cprLevels,
  emaSeries,
  macdSeries,
  rsiSeries,
  vwapSeries,
  type CprLevels,
  type MacdSeries,
  type SeriesPoint,
} from './indicator-series';
import type { Operand, OperandRef, RuleCondition, SessionPhase, StructurePattern } from './drawing-spec';

/**
 * Everything derivable from a candle series, computed once.
 *
 * Both the annotation engine and the rule evaluator need swings, levels, zones
 * and indicator series. Computing them per-consumer would be wasteful and,
 * more importantly, would let a rule fire against slightly different geometry
 * than the drawing it triggers is anchored to — the annotation would then be
 * placed somewhere its own stated reason does not hold.
 */
export interface ChartContext {
  candles: Candle[];
  snapshot: MarketSnapshot | null;
  swings: SwingPoint[];
  levels: PriceLevel[];
  zones: Zone[];
  pools: LiquidityPool[];
  gaps: FairValueGap[];
  trendLines: TrendLine[];
  fibonacci: FibonacciLevels | null;
  atr14: number | null;
  series: {
    ema20: SeriesPoint[];
    ema50: SeriesPoint[];
    ema200: SeriesPoint[];
    vwap: SeriesPoint[];
    rsi14: SeriesPoint[];
    macd: MacdSeries;
    cpr: CprLevels | null;
  };
}

export function buildChartContext(candles: Candle[], snapshot: MarketSnapshot | null): ChartContext {
  const swings = findSwings(candles, 3);
  return {
    candles,
    snapshot,
    swings,
    levels: findLevels(swings),
    zones: findZones(candles),
    pools: findLiquidityPools(candles, swings),
    gaps: findFairValueGaps(candles),
    trendLines: findTrendLines(candles, swings),
    fibonacci: findFibonacci(swings),
    atr14: atr(candles),
    series: {
      ema20: emaSeries(candles, 20),
      ema50: emaSeries(candles, 50),
      ema200: emaSeries(candles, 200),
      vwap: vwapSeries(candles),
      rsi14: rsiSeries(candles),
      macd: macdSeries(candles),
      cpr: cprLevels(snapshot?.priorDay ?? null),
    },
  };
}

// ---------------------------------------------------------------------------
// Operand resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a named quantity from the context.
 *
 * Returns null when the value genuinely does not exist — an instrument with no
 * prior day has no CPR, a 30-bar series has no EMA200. Null propagates into an
 * *unmet* condition with a stated reason, never into a default that would let
 * a rule fire on data that was never there.
 */
export function resolveOperand(operand: Operand, context: ChartContext, atIndex?: number): number | null {
  if ('value' in operand) return operand.value;
  const i = atIndex ?? context.candles.length - 1;
  const bar = context.candles[i];
  if (!bar) return null;

  const last = <T>(series: { value: T | null }[]): T | null => series[i]?.value ?? null;

  const map: Record<OperandRef, () => number | null> = {
    price: () => bar.close,
    open: () => bar.open,
    high: () => bar.high,
    low: () => bar.low,
    close: () => bar.close,
    volume: () => bar.volume,
    'volume.avg20': () => {
      const window = context.candles.slice(Math.max(0, i - 19), i + 1);
      if (window.length === 0) return null;
      return window.reduce((s, c) => s + c.volume, 0) / window.length;
    },
    ema20: () => last(context.series.ema20),
    ema50: () => last(context.series.ema50),
    ema200: () => last(context.series.ema200),
    vwap: () => last(context.series.vwap),
    rsi14: () => last(context.series.rsi14),
    'macd.histogram': () => last(context.series.macd.histogram),
    atr14: () => context.atr14,
    'cpr.pivot': () => context.series.cpr?.pivot ?? null,
    'cpr.tc': () => context.series.cpr?.tc ?? null,
    'cpr.bc': () => context.series.cpr?.bc ?? null,
    support: () => context.snapshot?.support ?? nearestLevel(context, bar.close, 'support')?.price ?? null,
    resistance: () => context.snapshot?.resistance ?? nearestLevel(context, bar.close, 'resistance')?.price ?? null,
    'openingRange.high': () => context.snapshot?.openingRange?.high ?? null,
    'openingRange.low': () => context.snapshot?.openingRange?.low ?? null,
    'priorDay.high': () => context.snapshot?.priorDay?.high ?? null,
    'priorDay.low': () => context.snapshot?.priorDay?.low ?? null,
    'priorDay.close': () => context.snapshot?.priorDay?.close ?? null,
    vix: () => context.snapshot?.vix ?? null,
  };

  return map[operand.ref]?.() ?? null;
}

export function nearestLevel(
  context: ChartContext,
  price: number,
  kind: 'support' | 'resistance',
): PriceLevel | null {
  const candidates = context.levels.filter((l) =>
    kind === 'support' ? l.price < price && l.kind === 'support' : l.price > price && l.kind === 'resistance',
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, l) => (Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best));
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

export interface ConditionResult {
  condition: RuleCondition;
  met: boolean;
  /** The condition restated with the live numbers that satisfied or failed it. */
  note: string;
}

/**
 * Evaluate one condition against live context.
 *
 * The `note` always contains the actual numbers, never a restatement of the
 * rule name. That is what makes a triggered annotation checkable: "EMA20
 * 24 318.4 is above EMA50 24 290.1" can be verified against the chart;
 * "ema_fast_above_slow: true" cannot.
 */
export function evaluateCondition(condition: RuleCondition, context: ChartContext): ConditionResult {
  switch (condition.kind) {
    case 'compare':
      return evaluateCompare(condition, context);
    case 'multiple-of':
      return evaluateMultipleOf(condition, context);
    case 'structure':
      return evaluateStructure(condition.pattern, condition, context);
    case 'session':
      return evaluateSession(condition.phase, condition, context);
  }
}

function evaluateCompare(
  condition: Extract<RuleCondition, { kind: 'compare' }>,
  context: ChartContext,
): ConditionResult {
  const left = resolveOperand(condition.left, context);
  const right = resolveOperand(condition.right, context);
  const leftName = 'ref' in condition.left ? condition.left.ref : String(condition.left.value);
  const rightName = 'ref' in condition.right ? condition.right.ref : String(condition.right.value);

  if (left === null || right === null) {
    const missing = left === null ? leftName : rightName;
    return { condition, met: false, note: `${missing} is unavailable on this series, so the condition cannot be evaluated` };
  }

  if (condition.op === 'crosses-above' || condition.op === 'crosses-below') {
    const previousIndex = context.candles.length - 2;
    const prevLeft = resolveOperand(condition.left, context, previousIndex);
    const prevRight = resolveOperand(condition.right, context, previousIndex);
    if (prevLeft === null || prevRight === null) {
      return { condition, met: false, note: `No prior bar available to detect a cross of ${leftName} through ${rightName}` };
    }
    const crossedAbove = prevLeft <= prevRight && left > right;
    const crossedBelow = prevLeft >= prevRight && left < right;
    const met = condition.op === 'crosses-above' ? crossedAbove : crossedBelow;
    return {
      condition,
      met,
      note: met
        ? `${leftName} ${left.toFixed(2)} crossed ${condition.op === 'crosses-above' ? 'above' : 'below'} ${rightName} ${right.toFixed(2)} on this bar (was ${prevLeft.toFixed(2)} vs ${prevRight.toFixed(2)})`
        : `${leftName} ${left.toFixed(2)} did not cross ${rightName} ${right.toFixed(2)} on this bar`,
    };
  }

  if (condition.op === 'within-pct') {
    const tolerance = condition.tolerancePct ?? 0.1;
    const distancePct = right !== 0 ? Math.abs((left - right) / right) * 100 : Number.POSITIVE_INFINITY;
    const met = distancePct <= tolerance;
    return {
      condition,
      met,
      note: `${leftName} ${left.toFixed(2)} is ${distancePct.toFixed(2)}% from ${rightName} ${right.toFixed(2)} (tolerance ${tolerance}%)`,
    };
  }

  const met =
    condition.op === '>' ? left > right
      : condition.op === '>=' ? left >= right
      : condition.op === '<' ? left < right
      : left <= right;

  return {
    condition,
    met,
    note: `${leftName} ${left.toFixed(2)} is ${met ? '' : 'not '}${symbolWord(condition.op)} ${rightName} ${right.toFixed(2)}`,
  };
}

function evaluateMultipleOf(
  condition: Extract<RuleCondition, { kind: 'multiple-of' }>,
  context: ChartContext,
): ConditionResult {
  const left = resolveOperand(condition.left, context);
  const right = resolveOperand(condition.right, context);
  const leftName = 'ref' in condition.left ? condition.left.ref : String(condition.left.value);
  const rightName = 'ref' in condition.right ? condition.right.ref : String(condition.right.value);

  if (left === null || right === null) {
    return { condition, met: false, note: `${left === null ? leftName : rightName} is unavailable, so the ratio cannot be evaluated` };
  }
  const threshold = right * condition.multiplier;
  const met =
    condition.op === '>' ? left > threshold
      : condition.op === '>=' ? left >= threshold
      : condition.op === '<' ? left < threshold
      : left <= threshold;

  const ratio = right !== 0 ? left / right : Number.POSITIVE_INFINITY;
  return {
    condition,
    met,
    note: `${leftName} is ${ratio.toFixed(2)}× ${rightName} (${left.toFixed(0)} vs ${right.toFixed(0)}), ${met ? 'meeting' : 'below'} the ${condition.multiplier}× requirement`,
  };
}

function evaluateStructure(
  pattern: StructurePattern,
  condition: RuleCondition,
  context: ChartContext,
): ConditionResult {
  const candles = context.candles;
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const result = (met: boolean, note: string): ConditionResult => ({ condition, met, note });

  if (!last) return result(false, 'No bars available');

  switch (pattern) {
    case 'liquidity-sweep': {
      const swept = context.pools.find((p) => p.swept);
      if (!swept) return result(false, 'No liquidity pool has been swept in the visible range');
      // A sweep is a wick through followed by a reclaim — a close beyond the
      // level is acceptance, which is the opposite outcome.
      const reclaimed =
        swept.kind === 'buy-side' ? last.high > swept.price && last.close < swept.price
          : last.low < swept.price && last.close > swept.price;
      return result(
        reclaimed,
        reclaimed
          ? `Price wicked through ${swept.kind} liquidity at ${swept.price.toFixed(1)} and closed back inside`
          : `${swept.kind} liquidity at ${swept.price.toFixed(1)} was taken but not reclaimed — that is acceptance, not a sweep`,
      );
    }
    case 'fair-value-gap': {
      const gap = context.gaps[context.gaps.length - 1];
      return gap
        ? result(true, `Unmitigated ${gap.direction} fair value gap between ${gap.bottom.toFixed(1)} and ${gap.top.toFixed(1)}`)
        : result(false, 'No unmitigated fair value gap in the visible range');
    }
    case 'order-block': {
      const zone = context.zones.find((z) => z.unmitigated);
      return zone
        ? result(true, `Unmitigated ${zone.kind} zone at ${zone.bottom.toFixed(1)}–${zone.top.toFixed(1)} from a ${zone.impulsePct.toFixed(2)}% impulse`)
        : result(false, 'No unmitigated supply or demand zone in the visible range');
    }
    case 'swing-high-break': {
      const level = [...context.levels].filter((l) => l.kind === 'resistance').sort((a, b) => b.strength - a.strength)[0];
      if (!level) return result(false, 'No resistance level formed to break');
      const met = last.close > level.price;
      return result(met, `Close ${last.close.toFixed(1)} is ${met ? 'above' : 'below'} the ${level.touches.length}-touch resistance at ${level.price.toFixed(1)}`);
    }
    case 'swing-low-break': {
      const level = [...context.levels].filter((l) => l.kind === 'support').sort((a, b) => b.strength - a.strength)[0];
      if (!level) return result(false, 'No support level formed to break');
      const met = last.close < level.price;
      return result(met, `Close ${last.close.toFixed(1)} is ${met ? 'below' : 'above'} the ${level.touches.length}-touch support at ${level.price.toFixed(1)}`);
    }
    case 'equal-highs': {
      const pool = context.pools.find((p) => p.kind === 'buy-side' && !p.swept);
      return pool
        ? result(true, `${pool.points.length} equal highs resting at ${pool.price.toFixed(1)}, not yet taken`)
        : result(false, 'No untaken equal highs in the visible range');
    }
    case 'equal-lows': {
      const pool = context.pools.find((p) => p.kind === 'sell-side' && !p.swept);
      return pool
        ? result(true, `${pool.points.length} equal lows resting at ${pool.price.toFixed(1)}, not yet taken`)
        : result(false, 'No untaken equal lows in the visible range');
    }
    case 'demand-zone-touch':
    case 'supply-zone-touch': {
      const kind = pattern === 'demand-zone-touch' ? 'demand' : 'supply';
      const zone = context.zones.find((z) => z.kind === kind && last.low <= z.top && last.high >= z.bottom);
      return zone
        ? result(true, `Price is trading inside the ${kind} zone at ${zone.bottom.toFixed(1)}–${zone.top.toFixed(1)}`)
        : result(false, `Price is not currently inside a ${kind} zone`);
    }
    case 'inside-bar': {
      if (!previous) return result(false, 'No prior bar to compare against');
      const met = last.high <= previous.high && last.low >= previous.low;
      return result(met, met
        ? `Current bar is contained inside the prior bar's ${previous.low.toFixed(1)}–${previous.high.toFixed(1)} range`
        : 'Current bar is not an inside bar');
    }
    case 'engulfing': {
      if (!previous) return result(false, 'No prior bar to compare against');
      const bullish = last.close > last.open && previous.close < previous.open && last.close >= previous.open && last.open <= previous.close;
      const bearish = last.close < last.open && previous.close > previous.open && last.close <= previous.open && last.open >= previous.close;
      return result(bullish || bearish, bullish || bearish
        ? `${bullish ? 'Bullish' : 'Bearish'} engulfing bar over the prior ${previous.open.toFixed(1)}–${previous.close.toFixed(1)} body`
        : 'Current bar does not engulf the prior body');
    }
  }
}

function evaluateSession(phase: SessionPhase, condition: RuleCondition, context: ChartContext): ConditionResult {
  const sessionCandles = context.snapshot?.sessionCandles ?? [];
  const result = (met: boolean, note: string): ConditionResult => ({ condition, met, note });

  if (sessionCandles.length === 0) return result(false, 'No session bars available to determine the phase');

  const start = sessionCandles[0].timestamp.getTime();
  const now = sessionCandles[sessionCandles.length - 1].timestamp.getTime();
  const elapsedMinutes = (now - start) / 60_000;
  // Indian equity session: 09:15–15:30 IST, 375 minutes.
  const SESSION_MINUTES = 375;

  const current: SessionPhase =
    elapsedMinutes < 30 ? 'opening-range'
      : elapsedMinutes < 60 ? 'first-hour'
      : elapsedMinutes < SESSION_MINUTES - 60 ? 'mid-session'
      : 'final-hour';

  return result(
    current === phase,
    `Session is ${elapsedMinutes.toFixed(0)} minutes in — currently the ${current.replace(/-/g, ' ')} phase`,
  );
}

function symbolWord(op: string): string {
  switch (op) {
    case '>': return 'above';
    case '>=': return 'at or above';
    case '<': return 'below';
    case '<=': return 'at or below';
    default: return op;
  }
}
