import type { ConfidenceBreakdown, MarketProfile, MarketStateValue, ObserveResponse } from '../domain';
import type { HistoricalSimilarityResult } from '../brain/historical-similarity.service';
import type { StrategyDetection } from '../intelligence/strategy-engine.service';

/**
 * The subset of `MarketBehaviourRead` the gate needs.
 *
 * Structural rather than an import of the full type: the gate must stay
 * constructible from plain objects in a test, and depending on the behaviour
 * module's whole shape would drag its transitive imports into every fixture.
 */
export interface BehaviourGateInput {
  read: 'continuation' | 'reversal-risk' | 'indecision' | 'undefined';
  direction: 'bullish' | 'bearish' | 'neutral';
  /** 0..1 supporting-evidence strength. */
  strength: number;
  structureState: 'uptrend' | 'downtrend' | 'range' | 'undefined';
}

/** Behaviour must be this well-supported before it counts as corroboration. */
export const MIN_BEHAVIOUR_STRENGTH = 0.35;

/**
 * The publication gate.
 *
 * Replaces the single `confidence.meetsThreshold` check that previously
 * decided whether market guidance reached a trader. Confidence alone was
 * never a sufficient condition: a high score assembled from factors that
 * mostly reported "no data" reads identically to one assembled from real
 * corroborating evidence, and the old fixed 85% threshold was doing the
 * filtering that structural checks should do — bluntly, and without ever
 * saying which piece of evidence was missing.
 *
 * An observation, Side in Focus, strategy read or market guidance is now
 * published only when ALL FOUR of these hold:
 *
 *  1. combined adaptive confidence >= PUBLICATION_CONFIDENCE_THRESHOLD (70),
 *  2. every mandatory confirmation the strategy defines has validated,
 *  3. no conflicting evidence is present, and
 *  4. corroboration across the reasoning modules is satisfied.
 *
 * When any condition fails the correct output is Wait and Watch, and
 * `waitAndWatchReason` names the binding constraint rather than a generic
 * "confidence too low" — a trader who is told nothing learns nothing.
 *
 * ## Why the threshold is fixed while the weights adapt
 *
 * `ConfidenceEngine.recalibrate()` retunes the *factor weights* from live
 * outcomes, so what a 70 means gets sharper over time. The threshold itself
 * is a constant here, deliberately: a system that can move its own
 * publication bar can quietly lower it, and no audit of a past observation
 * would be able to say what bar it actually cleared. Weights adapt; the gate
 * does not.
 *
 * ## What this gate does NOT govern
 *
 * Composite risk and behavioural warnings. A revenge-trading pattern or a
 * trap warning matters whether or not a technical setup confirmed, and
 * trapping a corroborated safety signal behind a strategy-confirmation
 * requirement would make the product least safe exactly where it exists to
 * help. That path keeps its own independent composite threshold, mirroring
 * the same `risk-elevated` asymmetry SentinelIntelligence's synthesis gate
 * already encodes.
 */

/**
 * The canonical publication bar. Fixed and auditable — see the note above on
 * why this is not adaptive even though the confidence feeding it is.
 */
export const PUBLICATION_CONFIDENCE_THRESHOLD = 70;

/**
 * Independent corroborating sources required before a directional read is
 * published. Two, for the same reason SentinelIntelligence requires two
 * agreeing agents: a single source is a single point of failure — an overfit
 * rule, a stale feed, a bug — and no confidence number makes it corroborated.
 */
export const MIN_CORROBORATING_SOURCES = 2;

/** States in which market guidance is meaningful at all. */
export const GUIDANCE_STATES: MarketStateValue[] = [
  'SIDE_IN_FOCUS',
  'OPPORTUNITY_ACTIVE',
  'MOVE_DEVELOPING',
  'MOMENTUM_WEAKENING',
  'MOVE_COMPLETE',
];

export type PublicationConditionId =
  | 'state-permits-guidance'
  | 'adaptive-confidence'
  | 'mandatory-confirmations'
  | 'no-conflicting-evidence'
  | 'corroboration';

export interface PublicationCondition {
  id: PublicationConditionId;
  label: string;
  passed: boolean;
  /** Human-readable evidence for why this condition passed or failed. */
  detail: string;
}

export interface PublicationDecision {
  publish: boolean;
  threshold: number;
  confidence: number;
  /** Every condition, passed or not — the full record, so "Why?" can show what was checked. */
  conditions: PublicationCondition[];
  /** Corroborating sources that agreed with the leading read. */
  corroboratingSources: string[];
  /** Evidence found to be in conflict, if any. */
  conflicts: string[];
  /** Null when publishing; otherwise the binding constraint, phrased for a trader. */
  waitAndWatchReason: string | null;
}

export interface PublicationGateInput {
  state: MarketStateValue;
  confidence: ConfidenceBreakdown;
  detections: StrategyDetection[];
  marketProfile: MarketProfile | null;
  historical: HistoricalSimilarityResult | null;
  crossValidation: ObserveResponse['crossValidation'];
  /**
   * Phase 2 — the structural/liquidity behaviour read. Optional so the gate
   * keeps working for callers that predate it (and so the tests can isolate
   * one condition at a time).
   */
  behaviour?: BehaviourGateInput | null;
  /** Overrides the fixed bar. Present so a trader may demand MORE evidence, never less — see `resolveThreshold`. */
  requestedThreshold?: number;
}

/**
 * A trader may raise the bar but never lower it below the canonical
 * threshold. Allowing a request to lower it would make the publication rule a
 * client-supplied parameter, and any caller could opt out of the gate.
 */
export function resolveThreshold(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return PUBLICATION_CONFIDENCE_THRESHOLD;
  return Math.max(PUBLICATION_CONFIDENCE_THRESHOLD, requested);
}

/**
 * Evaluate the four publication conditions.
 *
 * Pure and synchronous by construction: every input is resolved by the
 * caller. The single most important behavioural guarantee in the service must
 * be verifiable with no container, no database and no network.
 */
export function evaluatePublication(input: PublicationGateInput): PublicationDecision {
  const threshold = resolveThreshold(input.requestedThreshold);
  const score = input.confidence.score;
  const leading = input.detections[0] ?? null;

  const conditions: PublicationCondition[] = [];

  // --- 0: is guidance even meaningful in this state ----------------------
  const stateOk = GUIDANCE_STATES.includes(input.state);
  conditions.push({
    id: 'state-permits-guidance',
    label: 'Session state permits guidance',
    passed: stateOk,
    detail: stateOk
      ? `Sentinel is in ${input.state.replace(/_/g, ' ').toLowerCase()}`
      : `Sentinel is in ${input.state.replace(/_/g, ' ').toLowerCase()} — no setup has reached a guidance state`,
  });

  // --- 1: adaptive confidence -------------------------------------------
  const confidenceOk = score >= threshold;
  conditions.push({
    id: 'adaptive-confidence',
    label: 'Adaptive confidence at or above threshold',
    passed: confidenceOk,
    detail: `Combined adaptive confidence ${score.toFixed(1)}% against a ${threshold}% bar, across ${input.confidence.factors.length} weighted factors`,
  });

  // --- 2: mandatory confirmations ---------------------------------------
  // A strategy's rule list IS its mandatory confirmation set. A partially
  // confirmed setup is a *forming* setup and must not be published as a read,
  // however high the surrounding confidence climbs.
  const confirmation = evaluateMandatoryConfirmations(leading);
  conditions.push(confirmation.condition);

  // --- 3: conflicting evidence ------------------------------------------
  const conflict = evaluateConflicts(leading, input.marketProfile, input.crossValidation, input.behaviour ?? null);
  conditions.push(conflict.condition);

  // --- 4: corroboration across reasoning modules -------------------------
  const corroboration = evaluateCorroboration(
    leading,
    input.marketProfile,
    input.historical,
    input.crossValidation,
    input.behaviour ?? null,
  );
  conditions.push(corroboration.condition);

  const failed = conditions.filter((c) => !c.passed);
  const publish = failed.length === 0;

  return {
    publish,
    threshold,
    confidence: score,
    conditions,
    corroboratingSources: corroboration.sources,
    conflicts: conflict.conflicts,
    waitAndWatchReason: publish ? null : waitAndWatchReason(failed[0], score, threshold),
  };
}

/**
 * Condition 2 — every rule the strategy declares must have confirmed, and
 * nothing may have invalidated it.
 *
 * Reuses the engine's own `validated` flag rather than re-deriving the rule
 * arithmetic, so the gate and the strategy engine can never disagree about
 * whether a setup is confirmed.
 */
function evaluateMandatoryConfirmations(leading: StrategyDetection | null): { condition: PublicationCondition } {
  if (!leading) {
    return {
      condition: {
        id: 'mandatory-confirmations',
        label: 'All mandatory strategy confirmations validated',
        passed: false,
        detail: 'No strategy is currently detecting — there is no confirmation set to validate',
      },
    };
  }

  const total = leading.rulesMatched.length + leading.rulesUnmet.length;
  const invalidated = leading.invalidationsTriggered.length > 0;
  const passed = leading.validated && leading.rulesUnmet.length === 0 && !invalidated;

  let detail: string;
  if (invalidated) {
    detail = `${leading.strategyName} has an invalidation triggered — ${leading.invalidationsTriggered.join('; ')}`;
  } else if (leading.rulesUnmet.length > 0) {
    detail = `${leading.strategyName} is forming: ${leading.rulesMatched.length} of ${total} rules confirmed, still unmet — ${leading.rulesUnmet.join('; ')}`;
  } else {
    detail = `${leading.strategyName}: all ${leading.rulesMatched.length} mandatory rules confirmed, no invalidation`;
  }

  return {
    condition: { id: 'mandatory-confirmations', label: 'All mandatory strategy confirmations validated', passed, detail },
  };
}

/**
 * Condition 3 — no conflicting evidence.
 *
 * Two kinds of conflict are checked, and both are genuine contradictions
 * rather than mere absence of support:
 *
 *  - the setup points against the session's own structural read, and
 *  - SentinelIntelligence surfaced its own gated verdict and it disagrees.
 *
 * Engine 2 being silent is NOT a conflict. Its background coverage is
 * deliberately sparse (only cooldown-cleared new setups), so treating silence
 * as disagreement would make Engine 1 hostage to Engine 2's coverage gaps —
 * strictly worse than today, and the exact regression the reasoning-engine
 * merge was designed to avoid.
 */
function evaluateConflicts(
  leading: StrategyDetection | null,
  profile: MarketProfile | null,
  crossValidation: ObserveResponse['crossValidation'],
  behaviour: BehaviourGateInput | null,
): { condition: PublicationCondition; conflicts: string[] } {
  const conflicts: string[] = [];

  // Phase 2 — a change of character against the setup is the single most
  // informative contradiction available: the structure the setup depends on is
  // actively failing. Only counted when the behaviour read is itself
  // well-supported, so a marginal structural wobble cannot veto a clean setup.
  if (
    leading &&
    behaviour &&
    behaviour.read === 'reversal-risk' &&
    behaviour.direction !== 'neutral' &&
    behaviour.direction !== leading.bias &&
    behaviour.strength >= MIN_BEHAVIOUR_STRENGTH
  ) {
    conflicts.push(
      `market structure shows ${behaviour.direction} reversal risk against a ${leading.bias} setup (${(behaviour.strength * 100).toFixed(0)}% supporting evidence)`,
    );
  }

  if (leading && leading.bias !== 'neutral' && profile && profile.trend !== 'neutral' && profile.trend !== 'choppy') {
    if (leading.bias !== profile.trend) {
      conflicts.push(
        `${leading.strategyName} points ${leading.bias} against a ${profile.trend} session structure (${profile.type})`,
      );
    }
  }

  if (crossValidation && crossValidation.surfaced && !crossValidation.agreesWithConclusion) {
    conflicts.push(
      `SentinelIntelligence surfaced a corroborated reading that does not agree with this setup (${crossValidation.corroboratingAgents} agents)`,
    );
  }

  const passed = conflicts.length === 0;
  return {
    condition: {
      id: 'no-conflicting-evidence',
      label: 'No conflicting evidence',
      passed,
      detail: passed ? 'No contradicting structural or cross-engine evidence found' : conflicts.join('; '),
    },
    conflicts,
  };
}

/**
 * Condition 4 — corroboration across the reasoning modules.
 *
 * Counts INDEPENDENT sources that agree with the leading read. Independence
 * is the point: a second validated strategy, the session's structural
 * classification, a live-market track record, and the second reasoning engine
 * are four different ways of being right, and any two of them agreeing is a
 * materially stronger claim than one of them being confident.
 *
 * Deliberately NOT counted: the leading detection itself. It is the claim
 * being corroborated, and counting it would make the requirement satisfiable
 * by the very thing under test.
 */
function evaluateCorroboration(
  leading: StrategyDetection | null,
  profile: MarketProfile | null,
  historical: HistoricalSimilarityResult | null,
  crossValidation: ObserveResponse['crossValidation'],
  behaviour: BehaviourGateInput | null,
): { condition: PublicationCondition; sources: string[] } {
  const sources: string[] = [];

  if (leading) {
    if (profile && profile.trend === leading.bias) {
      sources.push(`session structure (${profile.type}) aligns with the ${leading.bias} side`);
    }
    // Phase 2 — behaviour corroborates only when it is CONTINUING in the
    // setup's direction with real supporting evidence. Indecision is not
    // agreement, and reversal-risk in the same direction is a contradiction in
    // terms rather than a second vote.
    if (
      behaviour &&
      behaviour.read === 'continuation' &&
      behaviour.direction === leading.bias &&
      behaviour.strength >= MIN_BEHAVIOUR_STRENGTH
    ) {
      sources.push(
        `market behaviour reads as ${behaviour.structureState} continuation on the ${leading.bias} side (${(behaviour.strength * 100).toFixed(0)}% supporting evidence)`,
      );
    }
    if (crossValidation && crossValidation.surfaced && crossValidation.agreesWithConclusion) {
      sources.push(
        `SentinelIntelligence agrees, corroborated by ${crossValidation.corroboratingAgents} independent agents`,
      );
    }
    if (historical && !historical.sampleTooSmall && historical.withKnownOutcome > 0) {
      sources.push(
        `${historical.withKnownOutcome} outcome-tagged historical occurrences of ${historical.patternName.replace(/_/g, ' ')} on this symbol`,
      );
    }
  }

  const passed = sources.length >= MIN_CORROBORATING_SOURCES;
  return {
    condition: {
      id: 'corroboration',
      label: 'Corroborated across reasoning modules',
      passed,
      detail: passed
        ? `Corroborated by ${sources.length} independent sources: ${sources.join('; ')}`
        : `Only ${sources.length} independent corroborating source${sources.length === 1 ? '' : 's'}; ${MIN_CORROBORATING_SOURCES} are required` +
          (sources.length > 0 ? ` (have: ${sources.join('; ')})` : ''),
    },
    sources,
  };
}

/**
 * Phrase the binding constraint for a trader.
 *
 * Names the specific missing evidence rather than a generic low-confidence
 * message. "Wait and Watch" with no reason teaches nothing; "Wait and Watch
 * because the retest volume rule has not confirmed" is the educational
 * product doing its job.
 */
function waitAndWatchReason(binding: PublicationCondition, score: number, threshold: number): string {
  const tail = ' Sentinel remains in Wait and Watch.';
  switch (binding.id) {
    case 'state-permits-guidance':
      return `${binding.detail}.${tail}`;
    case 'adaptive-confidence':
      return `Combined adaptive confidence is ${score.toFixed(1)}%, below the ${threshold}% publication threshold.${tail}`;
    case 'mandatory-confirmations':
      return `${binding.detail}. Every mandatory confirmation must validate before a read is published.${tail}`;
    case 'no-conflicting-evidence':
      return `Conflicting evidence is present — ${binding.detail}.${tail}`;
    case 'corroboration':
      return `${binding.detail}. A single source is not corroboration.${tail}`;
  }
}
