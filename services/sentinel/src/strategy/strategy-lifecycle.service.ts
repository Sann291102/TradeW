import { Injectable, Logger, Optional } from '@nestjs/common';
import { PatternRecognitionService } from '../brain/pattern-recognition.service';
import type { Signal } from '../domain';
import type { StrategyDetection } from '../intelligence/strategy-engine.service';
import {
  TERMINAL_STATES,
  evaluateLifecycle,
  lifecycleLabel,
  type LifecycleInput,
  type StrategyLifecycleState,
} from './strategy-lifecycle';

/**
 * Per-strategy lifecycle tracking — Phase 3.
 *
 * Holds one lifecycle state per (session, strategy) and advances it on every
 * observation. The session key convention is inherited from the existing state
 * machine — `userId::symbol::istDate` — because a lifecycle keyed globally
 * would let one trader's ORB retest overwrite another's, and a lifecycle not
 * keyed by date would carry yesterday's MOVE_COMPLETE into this morning.
 *
 * ## Where Phase 4 attaches
 *
 * When a strategy reaches a terminal state (MOVE_COMPLETE or INVALIDATED) this
 * service records the completed outcome to the Brain exactly once, then parks
 * the lifecycle in LEARN. That single write is what turns the lifecycle into a
 * learning loop: every completed strategy becomes an outcome-tagged occurrence
 * the confidence recalibration and the live-performance gate both read.
 *
 * `recordOnce` is not hygiene. `PatternRecognitionService.recordOccurrence` is
 * also written to by the orchestrator on every `/observe` and by the market
 * watch on every sweep; a lifecycle that re-recorded its outcome on each tick
 * would inflate the very sample the live-performance gate uses to decide
 * whether a pattern is proven, and an unproven pattern would certify itself.
 */
@Injectable()
export class StrategyLifecycleService {
  private readonly logger = new Logger(StrategyLifecycleService.name);

  /** `sessionKey::strategyId` → tracked lifecycle. */
  private readonly tracked = new Map<string, TrackedLifecycle>();

  /**
   * Hard cap on tracked lifecycles, as a backstop below the date eviction.
   *
   * The session key is `userId::symbol::istDate`, so entries accumulate with
   * every (user × symbol × strategy) seen today. Date eviction is the primary
   * mechanism; this bounds a single pathological day — a script sweeping every
   * symbol, or a user id that varies per request — from growing the map
   * without limit in a long-running process.
   */
  static readonly MAX_TRACKED = 5_000;

  constructor(
    /**
     * Optional for the same reason `MarketWatchService`'s is: the standalone
     * test module need not pull in the Brain's provider chain. When absent the
     * lifecycle still runs and still reports, it simply records nothing — and
     * says so, rather than looking healthy while writing no track record.
     */
    @Optional() private readonly patterns: PatternRecognitionService | null,
  ) {}

  /**
   * Advance every tracked strategy for this session.
   *
   * Strategies that were tracked but are absent from this scan are still
   * evaluated — with a null detection — because a setup vanishing from the
   * scan is itself a lifecycle event, and skipping them would freeze a
   * confirmed setup in place forever after it stopped matching.
   */
  /**
   * Drop lifecycles belonging to a day that is not the current IST date, and
   * enforce the hard cap.
   *
   * Runs on every `advance()` rather than from a market-close hook. A hook
   * would need something to fire it, and the two candidates both fail in the
   * cases that matter: a scheduled job does not run on a process that was
   * restarted after the close, and a client-driven call never arrives from a
   * tab that was closed. Date eviction is self-correcting — a session key
   * carries its own IST date, so a stale entry is identifiable without
   * remembering anything about how it was created.
   *
   * `clearSession` remains for explicit disposal; this is the safety net that
   * does not depend on anyone calling it.
   */
  private evictStale(now: Date): void {
    const today = istDateString(now);
    for (const [key, tracked] of this.tracked) {
      if (tracked.istDate !== today) this.tracked.delete(key);
    }
    // Oldest-first, since Map preserves insertion order.
    while (this.tracked.size > StrategyLifecycleService.MAX_TRACKED) {
      const oldest = this.tracked.keys().next().value;
      if (oldest === undefined) break;
      this.tracked.delete(oldest);
      this.logger.warn(`lifecycle cap reached — evicted ${oldest}`);
    }
  }

  async advance(ctx: {
    sessionKey: string;
    symbol: string;
    detections: StrategyDetection[];
    publishedStrategyId: string | null;
    behaviour: LifecycleInput['behaviour'];
    lastPrice: number | null;
    /** Regime at detection time — stamped onto the outcome for Phase 4 calibration. */
    regime: string | null;
    at: Date;
  }): Promise<LifecycleStatus[]> {
    this.evictStale(ctx.at);

    const byId = new Map(ctx.detections.map((d) => [d.strategyId, d]));
    const relevant = new Set<string>([
      ...byId.keys(),
      ...[...this.tracked.keys()]
        .filter((k) => k.startsWith(`${ctx.sessionKey}::`))
        .map((k) => k.slice(ctx.sessionKey.length + 2)),
    ]);

    const out: LifecycleStatus[] = [];
    for (const strategyId of relevant) {
      const key = `${ctx.sessionKey}::${strategyId}`;
      const existing = this.tracked.get(key);
      const detection = byId.get(strategyId) ?? null;
      const current = existing?.state ?? 'WATCHING';

      const evaluation = evaluateLifecycle(current, {
        detection,
        published: ctx.publishedStrategyId === strategyId,
        behaviour: ctx.behaviour,
        lastPrice: ctx.lastPrice,
        entryReference: existing?.entryReference ?? null,
      });

      // The reference price is stamped when the setup first goes live, and
      // never re-stamped — re-stamping it each tick would make the move
      // measurement always read zero and MOVE_COMPLETE unreachable.
      let entryReference = existing?.entryReference ?? null;
      if (entryReference === null && (evaluation.state === 'SIDE_IN_FOCUS' || evaluation.state === 'ACTIVE')) {
        entryReference = ctx.lastPrice;
      }

      const tracked: TrackedLifecycle = {
        state: evaluation.state,
        strategyId,
        strategyName: detection?.strategyName ?? existing?.strategyName ?? strategyId,
        bias: detection?.bias ?? existing?.bias ?? 'neutral',
        // Stamped once, when the lifecycle first sees the setup — the regime
        // the setup FORMED in is what its outcome should be attributed to, not
        // whichever regime happened to be current when it resolved.
        regime: existing?.regime ?? ctx.regime,
        /** IST date this lifecycle belongs to — what `evictStale` keys off. */
        istDate: existing?.istDate ?? istDateString(ctx.at),
        entryReference,
        enteredAt: evaluation.changed ? ctx.at : (existing?.enteredAt ?? ctx.at),
        outcomeRecorded: existing?.outcomeRecorded ?? false,
        history: [...(existing?.history ?? [])],
      };

      if (evaluation.changed) {
        tracked.history.push({ state: evaluation.state, at: ctx.at, reason: evaluation.reason });
        this.logger.log(`${ctx.symbol} ${strategyId}: ${current} → ${evaluation.state} (${evaluation.reason})`);
      }

      // --- Phase 4 hand-off ---------------------------------------------
      if (TERMINAL_STATES.includes(evaluation.state) && !tracked.outcomeRecorded) {
        tracked.outcomeRecorded = await this.recordOutcome(ctx.symbol, tracked, evaluation.state, ctx.lastPrice);
      }

      this.tracked.set(key, tracked);
      out.push({
        strategyId,
        strategyName: tracked.strategyName,
        state: evaluation.state,
        label: lifecycleLabel(evaluation.state),
        bias: tracked.bias,
        reason: evaluation.reason,
        evidence: evaluation.evidence,
        changed: evaluation.changed,
        enteredAt: tracked.enteredAt.toISOString(),
        history: tracked.history.map((h) => ({ state: h.state, at: h.at.toISOString(), reason: h.reason })),
      });
    }

    return out;
  }

  /**
   * Write the completed outcome to the Brain.
   *
   * Returns whether the write happened, so a failure does not mark the outcome
   * recorded and silently lose it — the next tick retries. A Brain outage must
   * cost a retry, never a lost outcome.
   */
  private async recordOutcome(
    symbol: string,
    tracked: TrackedLifecycle,
    terminal: StrategyLifecycleState,
    lastPrice: number | null,
  ): Promise<boolean> {
    if (!this.patterns) return false;
    const outcome = terminal === 'MOVE_COMPLETE' ? 'followed_through' : 'failed';
    const signal: Signal = {
      // Named identically to the orchestrator's `strategySignals` and the
      // watch's `validatedSignals` — `StrategyIntelligenceService.baseRateFor`
      // matches on this exact string, and three writers naming the same setup
      // differently would split the evidence three ways without ever saying so.
      name: tracked.strategyId.replace(/-/g, '_'),
      agent: 'strategy',
      triggered: true,
      weight: 0.4,
      evidence: [
        `${tracked.strategyName} lifecycle completed as ${terminal}`,
        ...tracked.history.map((h) => `${h.state}: ${h.reason}`),
      ],
      data: {
        strategyId: tracked.strategyId,
        bias: tracked.bias,
        outcome,
        terminal,
        entryReference: tracked.entryReference,
        // Phase 4 — persisted into the occurrence's metadata so calibration
        // can measure this strategy separately per regime.
        regime: tracked.regime,
        via: 'strategy-lifecycle',
      },
    };
    try {
      await this.patterns.recordOccurrence(symbol, signal, lastPrice ?? tracked.entryReference ?? 0);
      this.logger.log(`recorded ${outcome} outcome for ${symbol} ${tracked.strategyId}`);
      return true;
    } catch (err) {
      this.logger.warn(`failed to record lifecycle outcome for ${tracked.strategyId} (will retry): ${err}`);
      return false;
    }
  }

  /** Current lifecycle states for a session, for the operator endpoint and tests. */
  statesFor(sessionKey: string): LifecycleStatus[] {
    const out: LifecycleStatus[] = [];
    for (const [key, tracked] of this.tracked) {
      if (!key.startsWith(`${sessionKey}::`)) continue;
      out.push({
        strategyId: tracked.strategyId,
        strategyName: tracked.strategyName,
        state: tracked.state,
        label: lifecycleLabel(tracked.state),
        bias: tracked.bias,
        reason: tracked.history[tracked.history.length - 1]?.reason ?? 'Watching',
        evidence: [],
        changed: false,
        enteredAt: tracked.enteredAt.toISOString(),
        history: tracked.history.map((h) => ({ state: h.state, at: h.at.toISOString(), reason: h.reason })),
      });
    }
    return out;
  }

  /** Drop a session's lifecycles — used at market close. */
  clearSession(sessionKey: string): void {
    for (const key of [...this.tracked.keys()]) {
      if (key.startsWith(`${sessionKey}::`)) this.tracked.delete(key);
    }
  }
}

interface TrackedLifecycle {
  state: StrategyLifecycleState;
  strategyId: string;
  strategyName: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  /** Regime the setup formed in, stamped once and never re-stamped. */
  regime: string | null;
  /** IST date this lifecycle belongs to, for date-based eviction. */
  istDate: string;
  entryReference: number | null;
  enteredAt: Date;
  outcomeRecorded: boolean;
  history: { state: StrategyLifecycleState; at: Date; reason: string }[];
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar date for a moment, matching the session-key convention. */
function istDateString(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface LifecycleStatus {
  strategyId: string;
  strategyName: string;
  state: StrategyLifecycleState;
  label: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  reason: string;
  evidence: string[];
  changed: boolean;
  enteredAt: string;
  history: { state: StrategyLifecycleState; at: string; reason: string }[];
}
