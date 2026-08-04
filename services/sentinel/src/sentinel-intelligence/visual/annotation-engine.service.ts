import { Injectable } from '@nestjs/common';
import { enforceVocabulary } from '../../vocabulary/vocabulary';
import { KnowledgeIndexService } from '../knowledge/knowledge-index.service';
import { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import { compact } from './indicator-series';
import { nearestLevel, type ChartContext } from './chart-context';
import type { DrawingSpec, TradingViewStrategySpec } from './drawing-spec';
import type { RuleMatch } from './tradingview-rule.service';
import type {
  AnnotationKind,
  AnnotationStyle,
  ChartAnnotation,
  ChartPoint,
  KnowledgeCitation,
  ProjectedLevel,
  TriggeringRule,
  UnderstoodRequest,
} from '../types';

/**
 * Builds the annotation layer for the visual strategy workspace.
 *
 * The binding constraint, from the brief: **every annotation must explain why
 * it was placed, which rule triggered it, and with what confidence.** That is
 * enforced structurally rather than by convention — `ChartAnnotation` requires
 * `explanation`, `triggeredBy` and `confidence`, and the only way to construct
 * one here is through `annotate()`, which demands all three. There is no code
 * path that produces an unexplained drawing.
 *
 * Two sources of annotations, in priority order:
 *
 * 1. **Learned TradingView rules.** When a user's spec matches live structure,
 *    its drawings are reproduced with the author's own rationale and the live
 *    numbers that satisfied each condition. This is the "recognise the same
 *    structure, reproduce the same drawings" path.
 *
 * 2. **Built-in structural analysis.** Indicators the request asked for, plus
 *    the structure the geometry engine found. These carry `origin: 'builtin'`
 *    so a reader can always tell their own rules from the system's defaults.
 */
@Injectable()
export class AnnotationEngineService {
  constructor(
    private readonly index: KnowledgeIndexService,
    private readonly graph: ReasoningGraphService,
  ) {}

  build(
    context: ChartContext,
    understood: UnderstoodRequest,
    ruleMatches: RuleMatch[],
  ): ChartAnnotation[] {
    if (context.candles.length === 0) return [];

    const annotations: ChartAnnotation[] = [
      ...this.fromLearnedRules(context, ruleMatches),
      ...this.indicatorAnnotations(context, understood),
      ...this.structureAnnotations(context, understood),
    ];

    // Deduplicate: a learned rule and the built-in analysis routinely find the
    // same level. The user's own rule wins, because it carries their rationale
    // — but the built-in one is dropped rather than both being drawn, or the
    // chart accumulates a double line at every meaningful price.
    return dedupe(annotations);
  }

  // ---------------------------------------------------------------- rules

  private fromLearnedRules(context: ChartContext, matches: RuleMatch[]): ChartAnnotation[] {
    const out: ChartAnnotation[] = [];

    for (const match of matches) {
      // Partial matches draw nothing. A drawing is a claim that the setup is
      // present; rendering "4 of 7 rules" as the same lines as a confirmed
      // setup is precisely how a chart starts lying to its reader.
      if (!match.matched) continue;

      for (const drawing of match.spec.drawings) {
        const built = this.renderDrawing(context, drawing, match);
        if (built) out.push(built);
      }
    }
    return out;
  }

  private renderDrawing(context: ChartContext, drawing: DrawingSpec, match: RuleMatch): ChartAnnotation | null {
    const geometry = this.resolveAnchor(context, drawing);
    if (!geometry) return null;

    const conditionSummary = match.metNotes.slice(0, 3).join('; ');
    const triggeredBy: TriggeringRule = {
      ruleId: `user:${match.spec.id}`,
      ruleName: match.spec.name,
      origin: 'user-tradingview',
      conditionMet: conditionSummary || 'all conditions confirmed',
    };

    // Citations point back at the user's own spec, indexed at the `user-rule`
    // tier — so "which rule triggered this" resolves to a real, readable
    // document rather than an id the reader has to take on trust.
    const citations = this.index.cite(`${match.spec.name} ${drawing.kind} ${drawing.rationale}`, {
      limit: 3,
      preferKinds: ['user-rule'],
    });

    return this.annotate({
      kind: drawing.kind,
      label: interpolate(drawing.label, geometry),
      points: geometry.points,
      band: geometry.band,
      pane: paneFor(drawing.kind),
      style: styleFor(drawing.kind, drawing.style),
      explanation:
        `${drawing.rationale} Placed because ${match.spec.name} confirmed: ${conditionSummary || 'every condition held'}.`,
      triggeredBy,
      // Confidence in the drawing is the rule's match score tempered by how
      // many conditions it actually had. A one-condition rule matching is far
      // weaker evidence than a five-condition rule matching.
      confidence: Math.min(0.95, match.score * (0.6 + 0.08 * Math.min(5, match.spec.conditions.length))),
      citations,
      levels: this.projectedLevels(context, drawing, match.spec),
    });
  }

  /** Resolve a drawing's anchor into concrete chart geometry. */
  private resolveAnchor(
    context: ChartContext,
    drawing: DrawingSpec,
  ): { points: ChartPoint[]; band: { top: number; bottom: number } | null; price?: number; ratio?: string } | null {
    const candles = context.candles;
    const last = candles[candles.length - 1];
    if (!last) return null;
    const firstTime = candles[0].timestamp.getTime();
    const lastTime = last.timestamp.getTime();

    switch (drawing.anchor) {
      case 'recent-swing-lows':
      case 'recent-swing-highs': {
        const kind = drawing.anchor === 'recent-swing-lows' ? 'ascending' : 'descending';
        const line = context.trendLines.find((l) => (kind === 'ascending' ? l.from.kind === 'low' : l.from.kind === 'high'))
          ?? context.trendLines[0];
        if (!line) return null;
        return {
          points: [
            { time: line.from.time, price: line.from.price },
            { time: lastTime, price: line.priceAt(lastTime) },
          ],
          band: null,
          price: line.priceAt(lastTime),
        };
      }
      case 'nearest-level-above':
      case 'nearest-level-below': {
        const level = nearestLevel(
          context,
          last.close,
          drawing.anchor === 'nearest-level-above' ? 'resistance' : 'support',
        );
        if (!level) return null;
        return {
          points: [{ time: level.firstTime, price: level.price }, { time: lastTime, price: level.price }],
          band: null,
          price: level.price,
        };
      }
      case 'strongest-level': {
        const level = context.levels[0];
        if (!level) return null;
        return {
          points: [{ time: level.firstTime, price: level.price }, { time: lastTime, price: level.price }],
          band: null,
          price: level.price,
        };
      }
      case 'nearest-demand-zone':
      case 'nearest-supply-zone': {
        const kind = drawing.anchor === 'nearest-demand-zone' ? 'demand' : 'supply';
        const zone = context.zones.filter((z) => z.kind === kind).sort(
          (a, b) => Math.abs((a.top + a.bottom) / 2 - last.close) - Math.abs((b.top + b.bottom) / 2 - last.close),
        )[0];
        if (!zone) return null;
        return {
          points: [{ time: zone.startTime, price: zone.top }, { time: lastTime, price: zone.bottom }],
          band: { top: zone.top, bottom: zone.bottom },
          price: (zone.top + zone.bottom) / 2,
        };
      }
      case 'unswept-liquidity': {
        const pool = context.pools.find((p) => !p.swept);
        if (!pool) return null;
        return {
          points: [{ time: pool.startTime, price: pool.price }, { time: lastTime, price: pool.price }],
          band: null,
          price: pool.price,
        };
      }
      case 'latest-fair-value-gap': {
        const gap = context.gaps[context.gaps.length - 1];
        if (!gap) return null;
        return {
          points: [{ time: gap.time, price: gap.top }, { time: lastTime, price: gap.bottom }],
          band: { top: gap.top, bottom: gap.bottom },
          price: (gap.top + gap.bottom) / 2,
        };
      }
      case 'last-swing-leg': {
        const fib = context.fibonacci;
        if (!fib) return null;
        return {
          points: [{ time: fib.from.time, price: fib.from.price }, { time: fib.to.time, price: fib.to.price }],
          band: null,
          price: fib.to.price,
        };
      }
      case 'opening-range': {
        const range = context.snapshot?.openingRange;
        if (!range) return null;
        return {
          points: [{ time: firstTime, price: range.high }, { time: lastTime, price: range.low }],
          band: { top: range.high, bottom: range.low },
          price: range.high,
        };
      }
      case 'cpr': {
        const cpr = context.series.cpr;
        if (!cpr) return null;
        return {
          points: [{ time: firstTime, price: cpr.tc }, { time: lastTime, price: cpr.bc }],
          band: { top: cpr.tc, bottom: cpr.bc },
          price: cpr.pivot,
        };
      }
      case 'current-close':
        return { points: [{ time: lastTime, price: last.close }], band: null, price: last.close };
      case 'indicator-series': {
        const series = this.seriesFor(context, drawing.indicator ?? 'ema', drawing.period);
        if (series.length === 0) return null;
        return { points: series, band: null, price: series[series.length - 1].price };
      }
      default:
        return null;
    }
  }

  private seriesFor(context: ChartContext, indicator: string, period?: number): ChartPoint[] {
    const toPoints = (series: { time: number; value: number }[]) =>
      series.map((p) => ({ time: p.time, price: p.value }));

    switch (indicator) {
      case 'ema':
        return toPoints(compact(period === 50 ? context.series.ema50 : period === 200 ? context.series.ema200 : context.series.ema20));
      case 'vwap':
        return toPoints(compact(context.series.vwap));
      case 'rsi':
        return toPoints(compact(context.series.rsi14));
      case 'macd':
        return toPoints(compact(context.series.macd.histogram));
      default:
        return [];
    }
  }

  /**
   * Projected levels for a drawing that implies any.
   *
   * Measured in ATR multiples from the anchor, which is why they are geometry
   * rather than instruction: the distance comes from the instrument's own
   * realised range, and the objective is expressed as a multiple of the
   * invalidation distance the author's own rule specified.
   */
  private projectedLevels(
    context: ChartContext,
    drawing: DrawingSpec,
    spec: TradingViewStrategySpec,
  ): ProjectedLevel[] {
    if (!drawing.role) return [];
    const last = context.candles[context.candles.length - 1];
    const atrValue = context.atr14;
    if (!last || !atrValue) return [];

    const direction = spec.bias === 'bearish' ? -1 : 1;
    const multiple = drawing.atrMultiple ?? 1;

    switch (drawing.role) {
      case 'entry-zone':
        return [{ price: last.close, role: 'entry-zone', derivedFrom: `user:${spec.id}`, rMultiple: null }];
      case 'invalidation':
        return [
          {
            price: last.close - direction * atrValue * multiple,
            role: 'invalidation',
            derivedFrom: `user:${spec.id}`,
            rMultiple: null,
          },
        ];
      case 'objective': {
        const r = drawing.rMultiple ?? 2;
        return [
          {
            price: last.close + direction * atrValue * multiple * r,
            role: 'objective',
            derivedFrom: `user:${spec.id}`,
            rMultiple: r,
          },
        ];
      }
      default:
        return [];
    }
  }

  // ----------------------------------------------------------- indicators

  /**
   * Indicators the request asked for, plus the always-on baseline.
   *
   * EMA20/50 and VWAP are drawn unconditionally because the strategy rules
   * and several agents reason against them — a chart that omits the reference
   * the reasoning cites is not auditable.
   */
  private indicatorAnnotations(context: ChartContext, understood: UnderstoodRequest): ChartAnnotation[] {
    const wanted = new Set(understood.indicators);
    const out: ChartAnnotation[] = [];
    const lastTime = context.candles[context.candles.length - 1].timestamp.getTime();

    const push = (
      kind: AnnotationKind,
      label: string,
      points: ChartPoint[],
      explanation: string,
      ruleId: string,
      conditionMet: string,
      query: string,
      confidence = 0.9,
    ) => {
      if (points.length === 0) return;
      out.push(
        this.annotate({
          kind,
          label,
          points,
          band: null,
          pane: paneFor(kind),
          style: styleFor(kind),
          explanation,
          triggeredBy: { ruleId, ruleName: label, origin: 'builtin', conditionMet },
          confidence,
          citations: this.index.cite(query, { limit: 2, preferKinds: ['book', 'knowledge-base'] }),
          levels: [],
        }),
      );
    };

    const asPoints = (series: { time: number; value: number }[]) =>
      series.map((p) => ({ time: p.time, price: p.value }));

    push(
      'ema',
      'EMA 20',
      asPoints(compact(context.series.ema20)),
      'The 20-period exponential moving average, the short-term trend reference several strategy rules evaluate against.',
      'builtin:ema20',
      `EMA20 currently ${context.snapshot?.ema20?.toFixed(1) ?? 'n/a'}`,
      'exponential moving average trend reference',
    );
    push(
      'ema',
      'EMA 50',
      asPoints(compact(context.series.ema50)),
      'The 50-period exponential moving average. Its position relative to EMA20 is what the EMA-cross rules read.',
      'builtin:ema50',
      `EMA50 currently ${context.snapshot?.ema50?.toFixed(1) ?? 'n/a'}`,
      'moving average crossover trend',
    );
    if (wanted.has('ema') || understood.style === 'positional') {
      push(
        'ema',
        'EMA 200',
        asPoints(compact(context.series.ema200)),
        'The 200-period exponential moving average, the long-term regime reference.',
        'builtin:ema200',
        'requested, or implied by a positional style',
        'long term moving average regime',
      );
    }
    push(
      'vwap',
      'VWAP',
      asPoints(compact(context.series.vwap)),
      'Session-anchored volume-weighted average price — the session’s fair-value reference. It resets each day.',
      'builtin:vwap',
      `VWAP currently ${context.snapshot?.vwap?.toFixed(1) ?? 'n/a'}`,
      'VWAP volume weighted average price fair value',
    );

    if (wanted.has('rsi') || wanted.size === 0) {
      push(
        'rsi',
        'RSI 14',
        asPoints(compact(context.series.rsi14)),
        'Wilder’s 14-period RSI, plotted in its own pane. Read as momentum, not as an overbought/oversold instruction.',
        'builtin:rsi14',
        `RSI currently ${context.snapshot?.rsi14?.toFixed(1) ?? 'n/a'}`,
        'relative strength index momentum divergence',
      );
    }
    if (wanted.has('macd')) {
      push(
        'macd',
        'MACD histogram',
        asPoints(compact(context.series.macd.histogram)),
        'MACD(12,26,9) histogram — the distance between the MACD line and its signal, in its own pane.',
        'builtin:macd',
        `histogram currently ${context.snapshot?.macdHistogram?.toFixed(2) ?? 'n/a'}`,
        'MACD momentum convergence divergence',
      );
    }

    // CPR is a band, so it is built directly rather than through `push`.
    const cpr = context.series.cpr;
    if (cpr && (wanted.has('cpr') || wanted.has('pivot') || wanted.size === 0)) {
      const firstTime = context.candles[0].timestamp.getTime();
      out.push(
        this.annotate({
          kind: 'cpr',
          label: `CPR ${cpr.bc.toFixed(1)}–${cpr.tc.toFixed(1)}`,
          points: [{ time: firstTime, price: cpr.tc }, { time: lastTime, price: cpr.bc }],
          band: { top: cpr.tc, bottom: cpr.bc },
          pane: 'price',
          style: styleFor('cpr'),
          explanation:
            `Central Pivot Range from the prior session (pivot ${cpr.pivot.toFixed(1)}). A narrow CPR is associated with trending sessions and a wide one with rangebound sessions.`,
          triggeredBy: {
            ruleId: 'builtin:cpr',
            ruleName: 'Central Pivot Range',
            origin: 'builtin',
            conditionMet: `prior session ${context.snapshot?.priorDay?.low.toFixed(1) ?? '?'}–${context.snapshot?.priorDay?.high.toFixed(1) ?? '?'}`,
          },
          confidence: 0.9,
          citations: this.index.cite('central pivot range CPR narrow wide trending', {
            limit: 2,
            preferKinds: ['book', 'knowledge-base'],
          }),
          levels: [],
        }),
      );
    }

    return out;
  }

  // ------------------------------------------------------------ structure

  private structureAnnotations(context: ChartContext, understood: UnderstoodRequest): ChartAnnotation[] {
    const out: ChartAnnotation[] = [];
    const last = context.candles[context.candles.length - 1];
    const lastTime = last.timestamp.getTime();

    // ---- support / resistance ------------------------------------------
    for (const level of context.levels.slice(0, 4)) {
      const concept = this.graph.getConcept('support-resistance') ?? this.graph.detect('support resistance')[0] ?? null;
      out.push(
        this.annotate({
          kind: level.kind === 'support' ? 'support' : 'resistance',
          label: `${level.kind === 'support' ? 'Support' : 'Resistance'} ${level.price.toFixed(1)}`,
          points: [{ time: level.firstTime, price: level.price }, { time: lastTime, price: level.price }],
          band: null,
          pane: 'price',
          style: styleFor(level.kind === 'support' ? 'support' : 'resistance'),
          explanation:
            `Price reversed at ${level.price.toFixed(1)} on ${level.touches.length} separate occasions between ` +
            `${new Date(level.firstTime).toISOString().slice(0, 16).replace('T', ' ')} and ` +
            `${new Date(level.lastTime).toISOString().slice(0, 16).replace('T', ' ')}. ` +
            (concept?.explainer ? concept.explainer.split(/(?<=[.!?])\s+/)[0] : 'Repeated reaction is what makes the level worth marking.'),
          triggeredBy: {
            ruleId: 'builtin:swing-level-cluster',
            ruleName: 'Swing level cluster',
            origin: 'builtin',
            conditionMet: `${level.touches.length} swing pivots cluster within the tolerance band around ${level.price.toFixed(1)}`,
          },
          confidence: level.strength,
          citations: this.index.cite('support resistance level multiple touches', {
            limit: 2,
            preferKinds: ['book', 'knowledge-base'],
          }),
          levels: [],
        }),
      );
    }

    // ---- trend lines ----------------------------------------------------
    for (const line of context.trendLines) {
      out.push(
        this.annotate({
          kind: 'trendline',
          label: `${line.kind === 'ascending' ? 'Ascending' : 'Descending'} trendline`,
          points: [
            { time: line.from.time, price: line.from.price },
            { time: lastTime, price: line.priceAt(lastTime) },
          ],
          band: null,
          pane: 'price',
          style: styleFor('trendline'),
          explanation:
            `Fitted through ${line.from.kind} pivots at ${line.from.price.toFixed(1)} and ${line.to.price.toFixed(1)}, with ` +
            `${line.confirmations} further bar${line.confirmations === 1 ? '' : 's'} touching it. No candle closed beyond the line ` +
            'between the anchors, which is the test the line has to pass to be drawn at all.',
          triggeredBy: {
            ruleId: 'builtin:trendline-fit',
            ruleName: 'Validated trendline fit',
            origin: 'builtin',
            conditionMet: `${line.confirmations} confirming touches, zero closing violations`,
          },
          confidence: Math.min(0.9, 0.4 + line.confirmations * 0.12),
          citations: this.index.cite('trend line drawing higher lows validation', {
            limit: 2,
            preferKinds: ['book'],
          }),
          levels: [],
        }),
      );
    }

    // ---- supply / demand zones -----------------------------------------
    for (const zone of context.zones.filter((z) => z.unmitigated).slice(0, 3)) {
      out.push(
        this.annotate({
          kind: zone.kind === 'demand' ? 'demand-zone' : 'supply-zone',
          label: `${zone.kind === 'demand' ? 'Demand' : 'Supply'} ${zone.bottom.toFixed(1)}–${zone.top.toFixed(1)}`,
          points: [{ time: zone.startTime, price: zone.top }, { time: lastTime, price: zone.bottom }],
          band: { top: zone.top, bottom: zone.bottom },
          pane: 'price',
          style: styleFor(zone.kind === 'demand' ? 'demand-zone' : 'supply-zone'),
          explanation:
            `A ${Math.abs(zone.impulsePct).toFixed(2)}% impulse left this base behind and price has not traded back through it. ` +
            'The zone marks the consolidation the move originated from, not the move itself — that is where unfilled orders would remain.',
          triggeredBy: {
            ruleId: 'builtin:impulse-base',
            ruleName: 'Impulse origin base',
            origin: 'builtin',
            conditionMet: `${Math.abs(zone.impulsePct).toFixed(2)}% impulse bar following a base of narrower bars, unmitigated since`,
          },
          confidence: Math.min(0.9, 0.45 + Math.abs(zone.impulsePct) * 0.2),
          citations: this.index.cite('supply demand zone imbalance unfilled orders', {
            limit: 2,
            preferKinds: ['book', 'knowledge-base'],
          }),
          levels: [],
        }),
      );
    }

    // ---- liquidity pools -------------------------------------------------
    for (const pool of context.pools.filter((p) => !p.swept).slice(0, 3)) {
      out.push(
        this.annotate({
          kind: 'liquidity-pool',
          label: `${pool.kind === 'buy-side' ? 'Buy-side' : 'Sell-side'} liquidity ${pool.price.toFixed(1)}`,
          points: [{ time: pool.startTime, price: pool.price }, { time: lastTime, price: pool.price }],
          band: null,
          pane: 'price',
          style: styleFor('liquidity-pool'),
          explanation:
            `${pool.points.length} pivots line up at ${pool.price.toFixed(1)}, and the level has not been traded through. ` +
            `Equal ${pool.kind === 'buy-side' ? 'highs' : 'lows'} are where resting stop orders accumulate, which is what makes the level a magnet rather than a barrier.`,
          triggeredBy: {
            ruleId: 'builtin:equal-pivots',
            ruleName: 'Equal highs/lows cluster',
            origin: 'builtin',
            conditionMet: `${pool.points.length} pivots within 0.08% of ${pool.price.toFixed(1)}, unswept`,
          },
          confidence: Math.min(0.85, 0.45 + pool.points.length * 0.1),
          citations: this.index.cite('liquidity pool equal highs stop orders sweep', {
            limit: 2,
            preferKinds: ['book', 'knowledge-base'],
          }),
          levels: [],
        }),
      );
    }

    // ---- fair value gaps -------------------------------------------------
    for (const gap of context.gaps.slice(-2)) {
      out.push(
        this.annotate({
          kind: 'fair-value-gap',
          label: `${gap.direction === 'bullish' ? 'Bullish' : 'Bearish'} FVG ${gap.bottom.toFixed(1)}–${gap.top.toFixed(1)}`,
          points: [{ time: gap.time, price: gap.top }, { time: lastTime, price: gap.bottom }],
          band: { top: gap.top, bottom: gap.bottom },
          pane: 'price',
          style: styleFor('fair-value-gap'),
          explanation:
            `Three-bar imbalance: the range ${gap.bottom.toFixed(1)}–${gap.top.toFixed(1)} was skipped by the neighbouring bars’ wicks and has not been revisited.`,
          triggeredBy: {
            ruleId: 'builtin:fair-value-gap',
            ruleName: 'Three-bar imbalance',
            origin: 'builtin',
            conditionMet: `bar 1 ${gap.direction === 'bullish' ? 'high' : 'low'} does not overlap bar 3, gap unmitigated`,
          },
          confidence: 0.7,
          citations: this.index.cite('fair value gap imbalance three candle', {
            limit: 2,
            preferKinds: ['book', 'knowledge-base'],
          }),
          levels: [],
        }),
      );
    }

    // ---- fibonacci -------------------------------------------------------
    if (context.fibonacci && (understood.indicators.includes('fibonacci') || understood.indicators.length === 0)) {
      const fib = context.fibonacci;
      out.push(
        this.annotate({
          kind: 'fibonacci',
          label: `Fib ${fib.direction === 'up' ? '↑' : '↓'} ${fib.from.price.toFixed(1)}→${fib.to.price.toFixed(1)}`,
          points: fib.levels.map((l) => ({ time: lastTime, price: l.price })),
          band: null,
          pane: 'price',
          style: styleFor('fibonacci'),
          explanation:
            `Measured over the largest recent swing leg, from ${fib.from.price.toFixed(1)} to ${fib.to.price.toFixed(1)}. ` +
            `The 38.2% (${fib.levels[2].price.toFixed(1)}), 50% (${fib.levels[3].price.toFixed(1)}) and 61.8% (${fib.levels[4].price.toFixed(1)}) retracements are the levels most often watched.`,
          triggeredBy: {
            ruleId: 'builtin:fibonacci-leg',
            ruleName: 'Largest recent swing leg',
            origin: 'builtin',
            conditionMet: `swing leg of ${Math.abs(fib.to.price - fib.from.price).toFixed(1)} points between opposite pivots`,
          },
          confidence: 0.65,
          citations: this.index.cite('fibonacci retracement swing leg 61.8', {
            limit: 2,
            preferKinds: ['book'],
          }),
          levels: [],
        }),
      );
    }

    // ---- opening range ---------------------------------------------------
    const range = context.snapshot?.openingRange;
    if (range) {
      out.push(
        this.annotate({
          kind: 'opening-range',
          label: `Opening range ${range.low.toFixed(1)}–${range.high.toFixed(1)}`,
          points: [
            { time: context.candles[0].timestamp.getTime(), price: range.high },
            { time: lastTime, price: range.low },
          ],
          band: { top: range.high, bottom: range.low },
          pane: 'price',
          style: styleFor('opening-range'),
          explanation:
            `The first 30 minutes of the session established ${range.low.toFixed(1)}–${range.high.toFixed(1)}. Breaks of this range are what the ORB rules evaluate.`,
          triggeredBy: {
            ruleId: 'builtin:opening-range',
            ruleName: 'Opening range',
            origin: 'builtin',
            conditionMet: `range established by ${range.establishedAt.toISOString().slice(11, 16)} UTC`,
          },
          confidence: 0.85,
          citations: this.index.cite('opening range breakout first 30 minutes', {
            limit: 2,
            preferKinds: ['book', 'knowledge-base'],
          }),
          levels: [],
        }),
      );
    }

    return out;
  }

  /**
   * The single construction point for an annotation.
   *
   * Every field the audit contract requires is a parameter, and the explanation
   * passes through the vocabulary enforcer on the way out — an annotation is
   * user-facing text like any other, and the same observation-only rule applies
   * to a chart label as to a paragraph.
   */
  private annotate(input: {
    kind: AnnotationKind;
    label: string;
    points: ChartPoint[];
    band: { top: number; bottom: number } | null;
    pane: ChartAnnotation['pane'];
    style: AnnotationStyle;
    explanation: string;
    triggeredBy: TriggeringRule;
    confidence: number;
    citations: KnowledgeCitation[];
    levels: ProjectedLevel[];
  }): ChartAnnotation {
    const { clean } = enforceVocabulary(input.explanation);
    return {
      id: `${input.triggeredBy.ruleId}:${input.kind}:${Math.round(input.points[0]?.price ?? 0)}`,
      kind: input.kind,
      label: input.label,
      points: input.points,
      band: input.band,
      pane: input.pane,
      style: input.style,
      explanation: clean,
      triggeredBy: input.triggeredBy,
      confidence: Number(Math.max(0, Math.min(1, input.confidence)).toFixed(3)),
      citations: input.citations,
      levels: input.levels,
    };
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function paneFor(kind: AnnotationKind): ChartAnnotation['pane'] {
  if (kind === 'rsi') return 'rsi';
  if (kind === 'macd') return 'macd';
  return 'price';
}

/**
 * Default styling per annotation kind.
 *
 * Colours are semantic and consistent: green for demand/support, red for
 * supply/resistance, amber for liquidity and traps, blue for indicators. A
 * user spec can override any of it.
 */
function styleFor(kind: AnnotationKind, override?: DrawingSpec['style']): AnnotationStyle {
  const base: AnnotationStyle = (() => {
    switch (kind) {
      case 'support':
      case 'demand-zone':
        return { color: '#16a34a', width: 1, dash: 'solid', opacity: 0.14 };
      case 'resistance':
      case 'supply-zone':
        return { color: '#dc2626', width: 1, dash: 'solid', opacity: 0.14 };
      case 'liquidity-pool':
        return { color: '#f59e0b', width: 1, dash: 'dashed', opacity: 0.9 };
      case 'fair-value-gap':
        return { color: '#8b5cf6', width: 1, dash: 'solid', opacity: 0.16 };
      case 'order-block':
        return { color: '#0ea5e9', width: 1, dash: 'solid', opacity: 0.16 };
      case 'trendline':
        return { color: '#e2e8f0', width: 2, dash: 'solid', opacity: 0.9 };
      case 'fibonacci':
        return { color: '#a3a3a3', width: 1, dash: 'dotted', opacity: 0.8 };
      case 'ema':
        return { color: '#3b82f6', width: 2, dash: 'solid', opacity: 1 };
      case 'vwap':
        return { color: '#eab308', width: 2, dash: 'solid', opacity: 1 };
      case 'rsi':
        return { color: '#a855f7', width: 2, dash: 'solid', opacity: 1 };
      case 'macd':
        return { color: '#06b6d4', width: 2, dash: 'solid', opacity: 1 };
      case 'cpr':
        return { color: '#64748b', width: 1, dash: 'solid', opacity: 0.18 };
      case 'opening-range':
        return { color: '#94a3b8', width: 1, dash: 'dashed', opacity: 0.12 };
      case 'projected-entry':
        return { color: '#22d3ee', width: 1, dash: 'dashed', opacity: 0.9 };
      case 'projected-invalidation':
        return { color: '#f87171', width: 1, dash: 'dashed', opacity: 0.9 };
      case 'projected-objective':
        return { color: '#4ade80', width: 1, dash: 'dashed', opacity: 0.9 };
      default:
        return { color: '#cbd5e1', width: 1, dash: 'solid', opacity: 0.9 };
    }
  })();

  return {
    color: override?.color ?? base.color,
    width: override?.width ?? base.width,
    dash: override?.dash ?? base.dash,
    opacity: override?.opacity ?? base.opacity,
  };
}

/** Fill `{price}` / `{level}` placeholders in a user-supplied label. */
function interpolate(label: string, geometry: { price?: number; ratio?: string }): string {
  return label
    .replace(/\{price\}/g, geometry.price !== undefined ? geometry.price.toFixed(1) : '')
    .replace(/\{level\}/g, geometry.price !== undefined ? geometry.price.toFixed(1) : '')
    .replace(/\{ratio\}/g, geometry.ratio ?? '')
    .trim();
}

/**
 * Drop built-in annotations that duplicate a learned rule's drawing.
 *
 * Duplicates are judged on kind plus price proximity (0.05%), because the same
 * level found two ways is the same level. The user's rule is kept — it carries
 * their rationale, which is more useful to them than the generated one.
 */
function dedupe(annotations: ChartAnnotation[]): ChartAnnotation[] {
  const kept: ChartAnnotation[] = [];

  for (const annotation of annotations) {
    const price = annotation.points[0]?.price;
    const duplicate =
      price !== undefined &&
      kept.find(
        (k) =>
          k.kind === annotation.kind &&
          k.pane === annotation.pane &&
          k.points[0] !== undefined &&
          k.points[0].price !== 0 &&
          Math.abs(k.points[0].price - price) / Math.abs(k.points[0].price) < 0.0005,
      );

    if (!duplicate) {
      kept.push(annotation);
      continue;
    }
    // A learned rule replaces a built-in duplicate; a built-in never replaces
    // a learned rule.
    if (annotation.triggeredBy.origin === 'user-tradingview' && duplicate.triggeredBy.origin === 'builtin') {
      kept[kept.indexOf(duplicate)] = annotation;
    }
  }
  return kept;
}
