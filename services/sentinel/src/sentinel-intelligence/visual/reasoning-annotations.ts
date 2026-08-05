import type { Candle } from '@tradew/types';
import type { AnnotationKind, ChartAnnotation, ChartPoint } from '../types';
import type { MarketBehaviourRead } from '../../intelligence/market-behaviour.service';
import type { LifecycleStatus } from '../../strategy/strategy-lifecycle.service';

/**
 * Reasoning → chart annotations — Phase 5.
 *
 * `AnnotationEngineService` already draws the chart, but only from *learned
 * TradingView rules*: a trader had to have taught Sentinel a spec before
 * anything was drawn. Meanwhile the orchestrator was computing swing
 * structure, liquidity pools, sweeps, support/resistance and per-strategy
 * lifecycles on every observation — and drawing none of it.
 *
 * This module closes that gap. It converts what Sentinel actually reasoned
 * about into the existing `ChartAnnotation` shape, so the same renderer, the
 * same styling and the same audit guarantees apply. Nothing here invents a new
 * drawing pipeline.
 *
 * ## The rule inherited from the annotation engine, restated
 *
 * **Every annotation must explain itself.** `ChartAnnotation` requires
 * `explanation`, `triggeredBy` and `confidence`, and every builder below
 * supplies all three with the live numbers that produced them — never a
 * restatement of the rule name. "EMA20 24 318.4 is above EMA50 24 290.1" is
 * checkable against the chart; "EMA cross confirmed" is not.
 *
 * ## Partial setups draw nothing
 *
 * A drawing is a claim that the thing is present. A forming setup rendered
 * with the same lines as a confirmed one is how a chart starts lying to its
 * reader, so lifecycle annotations are emitted only from `CONFIRMED` onward,
 * and invalidated setups are drawn in their invalidated style rather than
 * silently disappearing — a level that mattered and then broke is information.
 */

/** Palette, kept here so reasoning annotations are visually distinguishable. */
const STYLE = {
  structure: { color: '#8ea0c4', width: 1, dash: 'dashed' as const, opacity: 1 },
  liquidity: { color: '#f0a53c', width: 1, dash: 'dotted' as const, opacity: 0.35 },
  sweep: { color: '#f0a53c', width: 2, dash: 'solid' as const, opacity: 1 },
  bullish: { color: '#14b8a6', width: 2, dash: 'solid' as const, opacity: 0.3 },
  bearish: { color: '#ef5350', width: 2, dash: 'solid' as const, opacity: 0.3 },
  invalidated: { color: '#6b7280', width: 1, dash: 'dotted' as const, opacity: 0.5 },
};

export interface ReasoningAnnotationInput {
  symbol: string;
  candles: Candle[];
  behaviour: MarketBehaviourRead | null;
  lifecycles: LifecycleStatus[];
  support: number | null;
  resistance: number | null;
  openingRange: { high: number; low: number } | null;
}

/**
 * Build every annotation implied by this observation's reasoning.
 *
 * Pure and synchronous — the same inputs always produce the same drawings,
 * which is what makes a rendered chart reproducible from a stored observation.
 */
export function buildReasoningAnnotations(input: ReasoningAnnotationInput): ChartAnnotation[] {
  const out: ChartAnnotation[] = [];
  if (input.candles.length === 0) return out;

  const first = input.candles[0];
  const last = input.candles[input.candles.length - 1];
  const span: [number, number] = [first.timestamp.getTime(), last.timestamp.getTime()];

  out.push(...structureAnnotations(input, span));
  out.push(...liquidityAnnotations(input, span));
  out.push(...levelAnnotations(input, span));
  out.push(...lifecycleAnnotations(input, span));

  return out;
}

/** Swing structure: the confirmed highs/lows the structural read is built on. */
function structureAnnotations(input: ReasoningAnnotationInput, span: [number, number]): ChartAnnotation[] {
  const behaviour = input.behaviour;
  if (!behaviour || behaviour.structure.state === 'undefined') return [];
  const out: ChartAnnotation[] = [];
  const { structure } = behaviour;

  if (structure.lastSwingHigh) {
    out.push(
      annotation({
        id: 'structure-swing-high',
        kind: 'resistance',
        label: `Swing high ${structure.lastSwingHigh.price.toFixed(1)}`,
        points: levelPoints(structure.lastSwingHigh.price, span),
        style: STYLE.structure,
        explanation: `Last confirmed swing high at ${structure.lastSwingHigh.price.toFixed(1)}. Structure reads as ${structure.state}. A close above this is the level that would ${structure.state === 'downtrend' ? 'change the character of the trend' : 'continue the existing structure'}.`,
        rule: { ruleId: 'market_structure', ruleName: 'Market structure', conditionMet: structure.evidence[0] ?? `${structure.state} structure` },
        confidence: behaviour.behaviour.strength,
      }),
    );
  }

  if (structure.lastSwingLow) {
    out.push(
      annotation({
        id: 'structure-swing-low',
        kind: 'support',
        label: `Swing low ${structure.lastSwingLow.price.toFixed(1)}`,
        points: levelPoints(structure.lastSwingLow.price, span),
        style: STYLE.structure,
        explanation: `Last confirmed swing low at ${structure.lastSwingLow.price.toFixed(1)}. Structure reads as ${structure.state}. A close below this is the level that would ${structure.state === 'uptrend' ? 'change the character of the trend' : 'continue the existing structure'}.`,
        rule: { ruleId: 'market_structure', ruleName: 'Market structure', conditionMet: structure.evidence[0] ?? `${structure.state} structure` },
        confidence: behaviour.behaviour.strength,
      }),
    );
  }

  return out;
}

/** Resting liquidity pools and the sweep that took them. */
function liquidityAnnotations(input: ReasoningAnnotationInput, span: [number, number]): ChartAnnotation[] {
  const behaviour = input.behaviour;
  if (!behaviour) return [];
  const out: ChartAnnotation[] = [];

  behaviour.liquidity.pools.slice(0, 4).forEach((pool, i) => {
    out.push(
      annotation({
        id: `liquidity-pool-${i}`,
        kind: 'liquidity-pool',
        label: `${pool.touches} touches ${pool.price.toFixed(1)}${pool.swept ? ' (swept)' : ''}`,
        points: levelPoints(pool.price, span),
        style: pool.swept ? STYLE.invalidated : STYLE.liquidity,
        explanation:
          `${pool.touches} swing points cluster at ${pool.price.toFixed(1)}, ${pool.side} current price — this is where stop orders rest. ` +
          (pool.swept
            ? 'Price has already traded through it, so this liquidity has been taken.'
            : 'It has not been traded through yet.'),
        rule: { ruleId: 'liquidity_behaviour', ruleName: 'Resting liquidity', conditionMet: `${pool.touches} swings within tolerance of ${pool.price.toFixed(1)}` },
        confidence: Math.min(1, 0.4 + pool.touches * 0.15),
      }),
    );
  });

  const sweep = behaviour.liquidity.recentSweep;
  if (sweep) {
    out.push(
      annotation({
        id: 'liquidity-sweep',
        kind: 'marker',
        label: sweep.reclaimed ? `Sweep ${sweep.price.toFixed(1)}` : `Acceptance ${sweep.price.toFixed(1)}`,
        points: levelPoints(sweep.price, span),
        style: STYLE.sweep,
        explanation: sweep.reclaimed
          ? `Price traded ${sweep.side} ${sweep.price.toFixed(1)} and closed back inside — the move reached resting stops without the market revaluing. This is a sweep, not a breakout.`
          : `Price traded ${sweep.side} ${sweep.price.toFixed(1)} and closed beyond it — the market accepted the new level rather than merely reaching stops.`,
        rule: { ruleId: 'liquidity_sweep', ruleName: 'Liquidity sweep', conditionMet: `close ${sweep.reclaimed ? 'returned inside' : 'held beyond'} ${sweep.price.toFixed(1)}` },
        confidence: sweep.reclaimed ? 0.75 : 0.6,
      }),
    );
  }

  return out;
}

/** Support, resistance and the opening range the engine already computed. */
function levelAnnotations(input: ReasoningAnnotationInput, span: [number, number]): ChartAnnotation[] {
  const out: ChartAnnotation[] = [];

  if (input.support !== null) {
    out.push(
      annotation({
        id: 'level-support',
        kind: 'support',
        label: `Support ${input.support.toFixed(1)}`,
        points: levelPoints(input.support, span),
        style: STYLE.bullish,
        explanation: `Lowest low across the lookback window, at ${input.support.toFixed(1)} — the level beneath which the recent range has not traded.`,
        rule: { ruleId: 'swing_levels', ruleName: 'Swing levels', conditionMet: `window low ${input.support.toFixed(1)}` },
        confidence: 0.6,
      }),
    );
  }

  if (input.resistance !== null) {
    out.push(
      annotation({
        id: 'level-resistance',
        kind: 'resistance',
        label: `Resistance ${input.resistance.toFixed(1)}`,
        points: levelPoints(input.resistance, span),
        style: STYLE.bearish,
        explanation: `Highest high across the lookback window, at ${input.resistance.toFixed(1)} — the level above which the recent range has not traded.`,
        rule: { ruleId: 'swing_levels', ruleName: 'Swing levels', conditionMet: `window high ${input.resistance.toFixed(1)}` },
        confidence: 0.6,
      }),
    );
  }

  if (input.openingRange) {
    out.push(
      annotation({
        id: 'opening-range',
        kind: 'opening-range',
        label: `ORB ${input.openingRange.low.toFixed(1)}–${input.openingRange.high.toFixed(1)}`,
        points: levelPoints(input.openingRange.high, span),
        band: { top: input.openingRange.high, bottom: input.openingRange.low },
        style: STYLE.structure,
        explanation: `Opening range established between ${input.openingRange.low.toFixed(1)} and ${input.openingRange.high.toFixed(1)}. Several configured strategies key off breaks and retests of these boundaries.`,
        rule: { ruleId: 'opening_range', ruleName: 'Opening range', conditionMet: `first 30 minutes: ${input.openingRange.low.toFixed(1)}–${input.openingRange.high.toFixed(1)}` },
        confidence: 0.8,
      }),
    );
  }

  return out;
}

/**
 * Strategy areas and invalidation levels, from the per-strategy lifecycle.
 *
 * Only from CONFIRMED onward — a forming setup drawn with confirmed styling is
 * a claim the chart is not entitled to make.
 */
function lifecycleAnnotations(input: ReasoningAnnotationInput, span: [number, number]): ChartAnnotation[] {
  const DRAWABLE = ['CONFIRMED', 'SIDE_IN_FOCUS', 'ACTIVE', 'MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'INVALIDATED'];
  const last = input.candles[input.candles.length - 1];

  return input.lifecycles
    .filter((l) => DRAWABLE.includes(l.state))
    .map((l, i) => {
      const invalidated = l.state === 'INVALIDATED';
      const style = invalidated ? STYLE.invalidated : l.bias === 'bearish' ? STYLE.bearish : STYLE.bullish;
      return annotation({
        id: `strategy-${l.strategyId}-${i}`,
        kind: invalidated ? 'marker' : 'projected-invalidation',
        label: `${l.strategyName} — ${l.label}`,
        points: levelPoints(last.close, span),
        style,
        explanation: `${l.strategyName} is at "${l.label}". ${l.reason}`,
        rule: {
          ruleId: l.strategyId,
          ruleName: l.strategyName,
          conditionMet: l.evidence[0] ?? l.reason,
        },
        // An invalidated setup keeps its drawing at reduced confidence rather
        // than vanishing: a level that mattered and then broke is information,
        // and a chart that erases its own history teaches nothing.
        confidence: invalidated ? 0.2 : 0.7,
      });
    });
}

// ---------------------------------------------------------------------------

/** A horizontal level as a two-point line spanning the visible range. */
function levelPoints(price: number, [from, to]: [number, number]): ChartPoint[] {
  return [
    { time: from, price },
    { time: to, price },
  ];
}

/**
 * The only constructor.
 *
 * Mirrors `AnnotationEngineService.annotate()`: explanation, triggeringRule and
 * confidence are required parameters, so an unexplained drawing is not
 * constructible rather than merely discouraged.
 */
function annotation(spec: {
  id: string;
  kind: AnnotationKind;
  label: string;
  points: ChartPoint[];
  style: ChartAnnotation['style'];
  explanation: string;
  rule: { ruleId: string; ruleName: string; conditionMet: string };
  confidence: number;
  band?: { top: number; bottom: number };
}): ChartAnnotation {
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    points: spec.points,
    band: spec.band ?? null,
    pane: 'price',
    style: spec.style,
    explanation: spec.explanation,
    triggeredBy: {
      ruleId: spec.rule.ruleId,
      ruleName: spec.rule.ruleName,
      // Sentinel's own deterministic reasoning, not a user spec or the corpus.
      origin: 'builtin',
      conditionMet: spec.rule.conditionMet,
    },
    confidence: Number(Math.max(0, Math.min(1, spec.confidence)).toFixed(3)),
    citations: [],
    levels: [],
  };
}
