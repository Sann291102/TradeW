/**
 * Strategy annotations for the chart — the bot's reasoning, on the price axis.
 *
 * ## The two questions this exists to answer
 *
 *   "Why did the bot trade here?"      — and, harder and more valuable,
 *   "Why did the bot NOT trade here?"
 *
 * The second is the one that decides whether these strategies are intelligent
 * or merely producing trades, and it is the one no existing surface answers.
 * The 2026-09-07 session is the evidence: 1,616 live evaluations, zero trades,
 * and the only way to learn why was to query `ExecutionEvaluationLog` by hand.
 * On a chart it is a glance.
 *
 * ## Why rejections are COLLAPSED INTO SPANS, not plotted per pass
 *
 * The evaluate loop runs every 30 seconds. One NSE session is ~750 passes, and
 * a 24/7 crypto agent produces ~2,880 a day. Plotting a marker per pass would
 * bury the chart in identical pins and make the rare, interesting transition —
 * the moment the reason CHANGED — invisible inside the noise.
 *
 * So consecutive passes sharing a `checkId` collapse into one span, and only
 * the span's start carries a marker. "Blocked by confidence-floor from 09:15 to
 * 11:40, 284 passes, peak confidence 58.1 against a 70 floor" is one readable
 * fact; 284 pins are not. The count and the peak are kept precisely because
 * collapsing must not throw away how close the agent came.
 *
 * ## The no-fabrication rule applies here too
 *
 * `ExecutionEvaluationLog.spot` is nullable — a pass that failed before reading
 * a price has none. Those annotations carry `price: null` and the client renders
 * them on the time axis rather than at an invented level. Placing them at the
 * previous known price would put the agent's reasoning at a price it never saw.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { marketForSymbol } from '@tradew/market-data';
import { rejectCheckLabel } from './execution-policy';

/** A point-in-time event on the chart. */
export interface StrategyAnnotation {
  /**
   * `signal`    — the bar a strategy validated on, before any order existed.
   * `entry`     — the fill that opened a position.
   * `exit`      — the fill that closed it.
   * `rejection` — a span during which the agent looked and declined.
   */
  kind: 'signal' | 'entry' | 'exit' | 'rejection';
  /** ISO instant. For a rejection span, its START. */
  at: string;
  /** Price in the ANALYSED instrument's space, or null when none was read. */
  price: number | null;

  /** One-line label for the marker itself. Kept short — it renders on-chart. */
  label: string;
  /** The full sentence, for the tooltip. Carries live numbers. */
  detail: string;

  strategyId: string | null;
  strategyName: string | null;
  /** 0-100 where known. Null is null, never 0 — see the no-fabrication rule. */
  confidence: number | null;
  regime: string | null;

  // ---- Rejection spans only ----------------------------------------------
  /** The groupable refusal id, e.g. `confidence-floor`. */
  checkId?: string;
  /** ISO instant the span ended. */
  until?: string;
  /** How many evaluation passes the span covers. */
  passes?: number;
  /**
   * The best confidence seen during the span.
   *
   * The single most useful number on a no-trade day: it is the difference
   * between "the agent was nowhere near" and "the agent was one point short
   * all afternoon", and those imply completely different next actions.
   */
  peakConfidence?: number | null;

  /** Entry/exit only — which intent this belongs to, for drill-through. */
  intentId?: string;
}

/** A horizontal level to draw across the chart while a position is open. */
export interface StrategyLevel {
  kind: 'entry' | 'stop' | 'target' | 'trail';
  price: number;
  label: string;
  /** ISO instants bounding the level's validity. `until` null = still open. */
  from: string;
  until: string | null;
  intentId: string;
}

export interface StrategyAnnotationSet {
  symbol: string;
  /** Which experiment market this symbol belongs to, or null if outside it. */
  market: string | null;
  /**
   * The price space the annotations are quoted in.
   *
   * LOAD-BEARING for the option path. A NIFTY agent's evaluation log records
   * the INDEX spot, but its position's stop and target are PREMIUM prices of a
   * CE contract — two different price spaces that must never be drawn on one
   * axis. `ExecutionProfile.trailStepPoints`' comment makes the same point
   * about trailing stops. So levels are emitted only when they share the
   * annotations' space, and this field tells the client which it got.
   */
  priceSpace: 'analysed' | 'traded';
  annotations: StrategyAnnotation[];
  levels: StrategyLevel[];
  /** True when levels were withheld because they live in a different space. */
  levelsWithheld: boolean;
  withheldReason: string | null;
}

@Injectable()
export class ChartAnnotationsService {
  constructor(private readonly prisma: PrismaService) {}

  async forSymbol(symbol: string, hours = 24): Promise<StrategyAnnotationSet> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const want = symbol.trim().toUpperCase();

    const [evaluations, intents] = await Promise.all([
      this.prisma.executionEvaluationLog.findMany({
        where: { symbol: want, at: { gte: since } },
        orderBy: { at: 'asc' },
      }),
      this.prisma.executionIntent.findMany({
        where: { symbol: want, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        // `outcome` as well as `position`: the EXIT price and instant live on
        // `ExecutionOutcome`, not on the position. `ExecutionPosition` records
        // the exit DECISION (`exitReason`, `exitDecidedAt`, written before the
        // order is placed so a failed exit still leaves its reason) while the
        // outcome records what the exit actually realised. Reading the exit
        // marker off the position would date it to when the manager decided,
        // not to when it filled — a difference of seconds normally and of
        // minutes on a retry, drawn on a chart as if it were the fill.
        include: { position: true, order: true, outcome: true },
      }),
    ]);

    const annotations: StrategyAnnotation[] = [
      ...this.rejectionSpans(evaluations),
      ...this.decisionAnnotations(intents),
    ].sort((a, b) => a.at.localeCompare(b.at));

    // ---- The price-space decision ------------------------------------------
    //
    // An option position's protection levels are premium prices. Drawing them
    // over an index chart would put a ₹142 stop on a 24,900 axis — visually
    // absurd at best, and at worst read as a real index level. Withheld, with
    // the reason stated, rather than silently converted or silently dropped.
    const optionPositions = intents.some((i) => i.optionType === 'CE' || i.optionType === 'PE');
    const levels = optionPositions ? [] : this.positionLevels(intents);

    return {
      symbol: want,
      market: marketForSymbol(want),
      priceSpace: 'analysed',
      annotations,
      levels,
      levelsWithheld: optionPositions,
      withheldReason: optionPositions
        ? 'Stop/target/trail for an option position are PREMIUM prices of the traded contract, not index levels. ' +
          'They cannot be drawn on the underlying\'s axis; open the contract chart to see them.'
        : null,
    };
  }

  /**
   * Collapse consecutive same-reason evaluation passes into spans.
   *
   * The grouping key is `checkId` — deliberately, not `reason`. `reason` is a
   * sentence with live numbers interpolated into it, so no two are ever equal
   * and grouping by it would collapse nothing at all. `execution-policy.ts`
   * makes exactly this argument for why `failedCheckId` exists alongside
   * `reason`; this is the same distinction applied to the chart.
   */
  private rejectionSpans(
    rows: Array<{
      at: Date;
      outcome: string;
      checkId: string | null;
      reason: string;
      spot: unknown;
      confidence: unknown;
      regime: string | null;
      strategyId: string | null;
      strategyName: string | null;
    }>,
  ): StrategyAnnotation[] {
    const spans: StrategyAnnotation[] = [];
    // Passes that produced a trade are not rejections; they are covered by the
    // intent annotations, which carry far more detail.
    const blocked = rows.filter((r) => r.outcome !== 'EXECUTED');

    for (const row of blocked) {
      const num = (v: unknown): number | null => (v == null ? null : Number(v));
      const last = spans[spans.length - 1];
      const key = row.checkId ?? row.outcome;
      const confidence = num(row.confidence);

      if (last && last.checkId === key) {
        // Extend the open span. `peakConfidence` takes the max rather than the
        // latest: how close the agent came is the fact worth keeping, and the
        // last pass of a span is not necessarily its best.
        last.until = row.at.toISOString();
        last.passes = (last.passes ?? 1) + 1;
        if (confidence != null) {
          last.peakConfidence =
            last.peakConfidence == null ? confidence : Math.max(last.peakConfidence, confidence);
        }
        continue;
      }

      spans.push({
        kind: 'rejection',
        at: row.at.toISOString(),
        price: num(row.spot),
        label: rejectCheckLabel(row.checkId),
        detail: row.reason,
        strategyId: row.strategyId,
        strategyName: row.strategyName,
        confidence,
        regime: row.regime,
        checkId: key,
        until: row.at.toISOString(),
        passes: 1,
        peakConfidence: confidence,
      });
    }

    return spans;
  }

  /** Signal, entry and exit markers from the decision record. */
  private decisionAnnotations(
    intents: Array<Record<string, any>>,
  ): StrategyAnnotation[] {
    const out: StrategyAnnotation[] = [];

    for (const intent of intents) {
      const num = (v: unknown): number | null => (v == null ? null : Number(v));
      const spot = num(intent.underlyingSpot);
      const rationale: string[] = Array.isArray(intent.rationale) ? intent.rationale : [];

      // THE SIGNAL — the decision, whether or not it became an order. A
      // REJECTED intent is included on purpose: it is the highest-value
      // "why not" on the chart, because the agent got all the way to a plan
      // and then a risk bound stopped it. That is a different and more
      // interesting refusal than "no setup", and collapsing the two would
      // lose it.
      out.push({
        kind: 'signal',
        at: (intent.createdAt as Date).toISOString(),
        price: spot,
        label: `${intent.bias === 'bullish' ? '▲' : '▼'} ${intent.strategyName ?? 'signal'}`,
        detail:
          `${intent.status}: ${intent.bias} at ${intent.confidence}% confidence. ` +
          (rationale.length ? rationale.join(' · ') : 'No rationale recorded.') +
          (intent.rejectReason ? ` — refused: ${intent.rejectReason}` : ''),
        strategyId: intent.strategyId ?? null,
        strategyName: intent.strategyName ?? null,
        confidence: intent.confidence ?? null,
        regime: intent.regime ?? null,
        intentId: intent.id,
      });

      const position = intent.position;
      if (position) {
        out.push({
          kind: 'entry',
          at: (position.entryAt as Date).toISOString(),
          price: Number(position.entryPrice),
          label: 'Entry',
          detail:
            `Entered ${position.quantity} of ${position.contractSymbol} at ${Number(position.entryPrice)}. ` +
            `Stop ${Number(position.stopPrice)}, target ${Number(position.targetPrice)}.`,
          strategyId: intent.strategyId ?? null,
          strategyName: intent.strategyName ?? null,
          confidence: intent.confidence ?? null,
          regime: intent.regime ?? null,
          intentId: intent.id,
        });

        // The exit comes from the OUTCOME — the record of what filled — and is
        // emitted only once both the instant and the price exist. A position in
        // EXITING state has a decided reason but no fill yet; marking that as an
        // exit would draw a closed trade that is still open.
        const outcome = intent.outcome;
        if (outcome?.exitAt && outcome.exitPrice != null) {
          const pnl = Number(outcome.realizedPnl);
          out.push({
            kind: 'exit',
            at: (outcome.exitAt as Date).toISOString(),
            price: Number(outcome.exitPrice),
            label: `Exit · ${outcome.exitReason}`,
            detail:
              `Closed at ${Number(outcome.exitPrice)} — ${outcome.exitReason}` +
              (outcome.invalidationReason ? ` (${outcome.invalidationReason})` : '') +
              `. ${outcome.result}, realised ${pnl}` +
              (outcome.holdingSeconds != null
                ? ` after ${Math.round(outcome.holdingSeconds / 60)} min held.`
                : '.'),
            strategyId: intent.strategyId ?? null,
            strategyName: intent.strategyName ?? null,
            confidence: intent.confidence ?? null,
            regime: intent.regime ?? null,
            intentId: intent.id,
          });
        }
      }
    }

    return out;
  }

  /** Stop/target/trail lines, valid for a position's lifetime. */
  private positionLevels(intents: Array<Record<string, any>>): StrategyLevel[] {
    const levels: StrategyLevel[] = [];

    for (const intent of intents) {
      const p = intent.position;
      if (!p) continue;
      const from = (p.entryAt as Date).toISOString();
      // Bounded by the OUTCOME's fill instant, not the position's state: a
      // level that stops being drawn when the manager DECIDED to exit would
      // disappear while the position was still open and still protected by it.
      const until = intent.outcome?.exitAt ? (intent.outcome.exitAt as Date).toISOString() : null;

      levels.push(
        { kind: 'entry', price: Number(p.entryPrice), label: 'Entry', from, until, intentId: intent.id },
        { kind: 'stop', price: Number(p.stopPrice), label: 'Stop', from, until, intentId: intent.id },
        { kind: 'target', price: Number(p.targetPrice), label: 'Target', from, until, intentId: intent.id },
      );

      // The trail is emitted ONLY once it has actually ratcheted. Drawing it at
      // the initial stop before any step would render two coincident lines and
      // imply a trail was active when none was — `stopPrice` is documented as
      // "the original, never rewritten" precisely so the two stay separable.
      if (p.trailPrice != null && p.trailSteps > 0) {
        levels.push({
          kind: 'trail',
          price: Number(p.trailPrice),
          label: `Trail (${p.trailSteps} step${p.trailSteps === 1 ? '' : 's'})`,
          from,
          until,
          intentId: intent.id,
        });
      }
    }

    return levels;
  }
}
