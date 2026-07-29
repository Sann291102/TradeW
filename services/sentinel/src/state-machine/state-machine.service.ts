/**
 * Module 9 — Market State Machine.
 *
 * Sentinel is always in exactly one of twelve states, and every transition is
 * legal, recorded and explained. State is held **per session key**
 * (user + symbol + IST trading date): this is a singleton Nest provider
 * serving many traders and instruments at once, so a single mutable "current
 * state" field would leak one trader's context into another's observation.
 *
 * Illegal jumps are not forced. When the evidence points at a state that is
 * not directly reachable, the machine takes the shortest legal step toward
 * it, so the transition history stays a faithful narrative of the session
 * rather than a set of teleports.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  ConfidenceBreakdown,
  MarketStateSnapshot,
  MarketStateValue,
  SessionPhase,
  StateTransition,
} from '../domain';
import { StrategyDetection } from '../intelligence/strategy-engine.service';
import { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { istDateKey, sessionPhaseAt } from '../market-clock';

/** Legal transitions. Every state can always fall through to MARKET_CLOSE. */
const TRANSITIONS: Record<MarketStateValue, MarketStateValue[]> = {
  PRE_MARKET: ['OBSERVATION', 'MARKET_CLOSE'],
  OBSERVATION: ['MARKET_UNDERSTANDING', 'WAIT_AND_WATCH', 'MARKET_CLOSE'],
  MARKET_UNDERSTANDING: ['STRATEGY_DETECTION', 'OBSERVATION', 'WAIT_AND_WATCH', 'MARKET_CLOSE'],
  STRATEGY_DETECTION: ['VALIDATION', 'MARKET_UNDERSTANDING', 'WAIT_AND_WATCH', 'MARKET_CLOSE'],
  VALIDATION: ['SIDE_IN_FOCUS', 'STRATEGY_DETECTION', 'WAIT_AND_WATCH', 'MARKET_CLOSE'],
  WAIT_AND_WATCH: ['OBSERVATION', 'MARKET_UNDERSTANDING', 'MARKET_CLOSE'],
  SIDE_IN_FOCUS: ['OPPORTUNITY_ACTIVE', 'MOMENTUM_WEAKENING', 'WAIT_AND_WATCH', 'MARKET_CLOSE'],
  OPPORTUNITY_ACTIVE: ['MOVE_DEVELOPING', 'MOMENTUM_WEAKENING', 'MARKET_CLOSE'],
  MOVE_DEVELOPING: ['MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'MARKET_CLOSE'],
  MOMENTUM_WEAKENING: ['MOVE_COMPLETE', 'SIDE_IN_FOCUS', 'WAIT_AND_WATCH', 'MARKET_CLOSE'],
  MOVE_COMPLETE: ['WAIT_AND_WATCH', 'OBSERVATION', 'MARKET_CLOSE'],
  MARKET_CLOSE: ['PRE_MARKET'],
};

/** States that mean "a move Sentinel already called out is under way". */
const IN_MOVE: MarketStateValue[] = ['SIDE_IN_FOCUS', 'OPPORTUNITY_ACTIVE', 'MOVE_DEVELOPING'];

const MAX_HISTORY = 200;
const SESSION_TTL_MS = 24 * 3_600_000;

interface SessionState {
  current: MarketStateValue;
  previous: MarketStateValue | null;
  since: string;
  history: StateTransition[];
  touchedAt: number;
}

export interface StateEvaluation {
  snapshot: MarketStateSnapshot;
  /** the transition made on this call, if any */
  transition: StateTransition | null;
  /** the state the evidence pointed at, which may be further than one hop */
  intent: MarketStateValue;
}

@Injectable()
export class MarketStateMachineService {
  private readonly logger = new Logger(MarketStateMachineService.name);
  private readonly sessions = new Map<string, SessionState>();

  /** user + symbol + IST trading date. */
  static sessionKey(userId: string, symbol: string, at: Date = new Date()): string {
    return `${userId}::${symbol}::${istDateKey(at)}`;
  }

  /**
   * Read the evidence, decide where Sentinel should be, and take at most one
   * legal step toward it.
   */
  advance(
    key: string,
    input: {
      snapshot: MarketSnapshot;
      detections: StrategyDetection[];
      confidence: ConfidenceBreakdown;
      at?: Date;
    },
  ): StateEvaluation {
    const at = input.at ?? new Date();
    const phase = sessionPhaseAt(at);
    const session = this.session(key, at);

    const intent = this.intendedState(session.current, phase, input);
    let transition: StateTransition | null = null;

    if (intent !== session.current) {
      const next = nextHopToward(session.current, intent);
      if (next) {
        transition = {
          from: session.current,
          to: next,
          at: at.toISOString(),
          trigger: this.describeTrigger(next, input),
        };
        session.previous = session.current;
        session.current = next;
        session.since = transition.at;
        session.history.push(transition);
        if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
        this.logger.debug(`${key}: ${transition.from} -> ${transition.to} (${transition.trigger})`);
      } else {
        this.logger.warn(`${key}: no legal path from ${session.current} to ${intent} — holding`);
      }
    }

    session.touchedAt = at.getTime();
    this.prune(at);

    return {
      snapshot: {
        current: session.current,
        previous: session.previous,
        since: session.since,
        sessionPhase: phase,
        history: [...session.history],
      },
      transition,
      intent,
    };
  }

  /** Current state without advancing — used by read-only surfaces. */
  peek(key: string, at: Date = new Date()): MarketStateSnapshot {
    const session = this.session(key, at);
    return {
      current: session.current,
      previous: session.previous,
      since: session.since,
      sessionPhase: sessionPhaseAt(at),
      history: [...session.history],
    };
  }

  private session(key: string, at: Date): SessionState {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const phase = sessionPhaseAt(at);
    const created: SessionState = {
      current: phase === 'pre-market' ? 'PRE_MARKET' : phase === 'closed' ? 'MARKET_CLOSE' : 'OBSERVATION',
      previous: null,
      since: at.toISOString(),
      history: [],
      touchedAt: at.getTime(),
    };
    this.sessions.set(key, created);
    return created;
  }

  private prune(at: Date): void {
    const cutoff = at.getTime() - SESSION_TTL_MS;
    for (const [key, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(key);
    }
  }

  /** Where the evidence says Sentinel belongs, ignoring reachability. */
  private intendedState(
    current: MarketStateValue,
    phase: SessionPhase,
    input: { snapshot: MarketSnapshot; detections: StrategyDetection[]; confidence: ConfidenceBreakdown },
  ): MarketStateValue {
    if (phase === 'pre-market') return 'PRE_MARKET';
    if (phase === 'closed') return 'MARKET_CLOSE';

    const { snapshot, detections, confidence } = input;
    const validated = detections.filter((d) => d.validated);
    const meets = confidence.meetsThreshold;

    // A move Sentinel has already surfaced runs its own arc: it deepens while
    // confidence holds, and unwinds through weakening to complete when it does not.
    if (IN_MOVE.includes(current)) {
      if (!meets) return 'MOMENTUM_WEAKENING';
      if (current === 'SIDE_IN_FOCUS') return 'OPPORTUNITY_ACTIVE';
      if (current === 'OPPORTUNITY_ACTIVE') return 'MOVE_DEVELOPING';
      return 'MOVE_DEVELOPING';
    }
    if (current === 'MOMENTUM_WEAKENING') {
      return meets && validated.length > 0 ? 'SIDE_IN_FOCUS' : 'MOVE_COMPLETE';
    }
    if (current === 'MOVE_COMPLETE') return 'WAIT_AND_WATCH';

    if (!snapshot.marketProfile) return 'OBSERVATION';
    if (validated.length > 0 && meets) return 'SIDE_IN_FOCUS';
    if (validated.length > 0) return 'VALIDATION';
    if (detections.length > 0) return 'STRATEGY_DETECTION';
    if (confidence.score < 40) return 'WAIT_AND_WATCH';
    return 'MARKET_UNDERSTANDING';
  }

  /** Plain, non-directive reason for the move. */
  private describeTrigger(
    to: MarketStateValue,
    input: { snapshot: MarketSnapshot; detections: StrategyDetection[]; confidence: ConfidenceBreakdown },
  ): string {
    const { snapshot, detections, confidence } = input;
    const leading = detections[0];
    switch (to) {
      case 'PRE_MARKET':
        return 'Session has not opened';
      case 'MARKET_CLOSE':
        return 'Session has closed';
      case 'OBSERVATION':
        return 'Collecting bars — structure not yet classifiable';
      case 'MARKET_UNDERSTANDING':
        return snapshot.marketProfile
          ? `Session classified as ${snapshot.marketProfile.type}`
          : 'Session structure taking shape';
      case 'STRATEGY_DETECTION':
        return leading
          ? `${leading.strategyName} forming — ${leading.rulesMatched.length} of ${leading.rulesMatched.length + leading.rulesUnmet.length} rules confirmed`
          : 'A configured setup began to form';
      case 'VALIDATION':
        return leading
          ? `${leading.strategyName} fully confirmed; confidence ${confidence.score}% against a ${confidence.threshold}% threshold`
          : 'Setup confirmed, awaiting confidence';
      case 'SIDE_IN_FOCUS':
        return `Confidence ${confidence.score}% cleared the ${confidence.threshold}% threshold`;
      case 'OPPORTUNITY_ACTIVE':
        return `Confidence holding at ${confidence.score}% with the structure intact`;
      case 'MOVE_DEVELOPING':
        return snapshot.trendAnalysis
          ? `Move extending — session change ${snapshot.trendAnalysis.sessionChangePct >= 0 ? '+' : ''}${snapshot.trendAnalysis.sessionChangePct.toFixed(2)}%`
          : 'Move extending';
      case 'MOMENTUM_WEAKENING':
        return `Confidence fell to ${confidence.score}%, below the ${confidence.threshold}% threshold`;
      case 'MOVE_COMPLETE':
        return 'Expected move largely complete';
      case 'WAIT_AND_WATCH':
        return `Confidence ${confidence.score}% — below the ${confidence.threshold}% threshold, no side in focus`;
      default:
        return 'State updated';
    }
  }
}

/** Breadth-first shortest legal step from `from` toward `to`. */
export function nextHopToward(from: MarketStateValue, to: MarketStateValue): MarketStateValue | null {
  if (from === to) return null;
  const queue: MarketStateValue[][] = [[from]];
  const seen = new Set<MarketStateValue>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const tail = path[path.length - 1];
    for (const next of TRANSITIONS[tail]) {
      if (seen.has(next)) continue;
      if (next === to) return path.length === 1 ? next : path[1];
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

export function allowedTransitions(from: MarketStateValue): MarketStateValue[] {
  return [...TRANSITIONS[from]];
}
