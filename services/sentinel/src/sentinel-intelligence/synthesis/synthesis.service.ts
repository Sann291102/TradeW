import { Inject, Injectable, Logger } from '@nestjs/common';
import { enforceVocabulary, hasDirectiveLanguage } from '../../vocabulary/vocabulary';
import { SI_CONFIG, SentinelIntelligenceConfig } from '../si.config';
import type { CrossCheckResult } from './cross-check.service';
import {
  SI_DISCLAIMER,
  type AgentVerdict,
  type KnowledgeCitation,
  type Stance,
  type SupportingConcept,
  type SurfacedObservation,
  type SynthesisResult,
  type UnderstoodRequest,
} from '../types';

/**
 * The gate.
 *
 * SentinelIntelligence is silent by default. An observation is surfaced only
 * when BOTH conditions hold:
 *
 *  1. aggregate confidence ≥ the threshold (0.70 by default), and
 *  2. at least N non-abstaining agents (2 by default) independently landed on
 *     the leading stance.
 *
 * Neither substitutes for the other, and that is the whole point. One agent at
 * 95% is a single point of failure — an overfit threshold, a stale feed, a bug
 * — and no confidence number makes it corroborated. Two agents at 71% agreeing
 * from different evidence is a genuinely stronger claim than one at 95%.
 *
 * When the gate does not clear, the correct output is nothing at all:
 * `observation` is null, `silenceReason` names the gate that held, and the
 * caller shows the trader no speculative conclusion. Silence is the designed
 * behaviour, not a degraded mode.
 */
@Injectable()
export class SynthesisService {
  private readonly logger = new Logger(SynthesisService.name);

  constructor(@Inject(SI_CONFIG) private readonly config: SentinelIntelligenceConfig) {}

  synthesize(
    understood: UnderstoodRequest,
    verdicts: AgentVerdict[],
    crossCheck: CrossCheckResult,
    overrides: { confidenceThreshold?: number; requiredCorroboration?: number } = {},
  ): SynthesisResult {
    const threshold = clamp01(overrides.confidenceThreshold ?? this.config.confidenceThreshold);
    const requiredCorroboration = Math.max(
      1,
      overrides.requiredCorroboration ?? this.config.requiredCorroboration,
    );

    const confidence = this.aggregate(crossCheck);
    const { leadingStance, corroboratingAgents } = crossCheck;

    const base: Omit<SynthesisResult, 'surfaced' | 'observation' | 'silenceReason'> = {
      confidence,
      threshold,
      corroboratingAgents,
      requiredCorroboration,
      leadingStance,
      corroboration: crossCheck.corroboration,
      conflicts: crossCheck.conflicts,
      validationFailures: crossCheck.validationFailures,
    };

    // ---- gate 1: corroboration -----------------------------------------
    // Checked before confidence so the silence reason names the binding
    // constraint rather than whichever check happened to run first.
    if (corroboratingAgents < requiredCorroboration) {
      return {
        ...base,
        surfaced: false,
        observation: null,
        silenceReason:
          `Only ${corroboratingAgents} agent${corroboratingAgents === 1 ? '' : 's'} reached the "${leadingStance}" reading; ` +
          `${requiredCorroboration} corroborating agents are required. Monitoring continues.`,
      };
    }

    // ---- gate 2: confidence ---------------------------------------------
    if (confidence < threshold) {
      return {
        ...base,
        surfaced: false,
        observation: null,
        silenceReason:
          `Aggregate confidence is ${(confidence * 100).toFixed(0)}%, below the ${(threshold * 100).toFixed(0)}% threshold` +
          (crossCheck.totalPenalty > 0
            ? ` (reduced by ${(crossCheck.totalPenalty * 100).toFixed(0)} points from ${crossCheck.conflicts.length} unresolved conflict(s))`
            : '') +
          '. Monitoring continues.',
      };
    }

    // ---- gate 3: a corroborated non-read is still nothing to say --------
    // 'neutral' means the agents agree there is no signal. Publishing "the
    // agents agree nothing is happening" as an observation would train the
    // reader to ignore the surface entirely.
    if (leadingStance === 'neutral' || leadingStance === 'no-read') {
      return {
        ...base,
        surfaced: false,
        observation: null,
        silenceReason:
          'The corroborated reading is that no clear structure is present. There is nothing worth surfacing. Monitoring continues.',
      };
    }

    const observation = this.compose(understood, verdicts, crossCheck, confidence);

    // ---- gate 4: compliance backstop ------------------------------------
    // If directive vocabulary survives enforcement, the composition is refused
    // outright rather than published with a warning. A gap in the rewrite table
    // must fail closed.
    if (hasDirectiveLanguage(observation.content)) {
      this.logger.error(
        'synthesis produced directive language that survived vocabulary enforcement — refusing to surface',
      );
      return {
        ...base,
        surfaced: false,
        observation: null,
        silenceReason:
          'The composed observation did not pass the observation-only compliance check and was withheld.',
      };
    }

    return { ...base, surfaced: true, observation, silenceReason: null };
  }

  /**
   * Aggregate confidence across corroborating agents.
   *
   * A weighted mean over the leading stance, then a breadth bonus, then
   * conflict penalties. The mean is over *agreeing* agents only: averaging in
   * the neutral agents would drag every reading toward the threshold from
   * below and make the gate a function of how many agents happened to run.
   *
   * The breadth bonus is capped at four agents. Beyond that the marginal agent
   * adds little genuine independence — they are all reading one snapshot — and
   * an uncapped bonus would let agent count substitute for evidence quality.
   */
  private aggregate(crossCheck: CrossCheckResult): number {
    const agreeing = crossCheck.corroboration.filter((c) => c.stance === crossCheck.leadingStance);
    if (agreeing.length === 0) return 0;

    const totalWeight = agreeing.reduce((s, c) => s + c.effectiveWeight, 0);
    if (totalWeight <= 0) return 0;

    const weightedMean = agreeing.reduce((s, c) => s + c.confidence * c.effectiveWeight, 0) / totalWeight;
    const breadthBonus = 0.06 * Math.min(4, agreeing.length - 1);

    return clamp01(weightedMean + breadthBonus - crossCheck.totalPenalty);
  }

  /**
   * Compose the trader-facing observation.
   *
   * Deterministic by construction — no LLM. The orchestrator polishes prose
   * through a model because it produces a single conversational paragraph;
   * this engine's output is an evidence chain whose value is that it is
   * verifiable, and passing it through a model to be reworded introduces a
   * step where a citation can drift from the claim it supports.
   *
   * Structure is fixed: status → the evidence that produced it → the citations
   * behind it → a reminder that it is an observation.
   */
  private compose(
    understood: UnderstoodRequest,
    verdicts: AgentVerdict[],
    crossCheck: CrossCheckResult,
    confidence: number,
  ): SurfacedObservation {
    const stance = crossCheck.leadingStance;
    const agreeingAgents = new Set(
      crossCheck.corroboration.filter((c) => c.stance === stance).map((c) => c.agent),
    );
    const contributors = verdicts.filter((v) => agreeingAgents.has(v.agent) && !v.abstained);

    const status = statusFor(stance, understood.market.symbol);

    // Strongest evidence from each contributing agent — one line each, so the
    // paragraph reflects breadth of agreement rather than one verbose agent.
    const evidenceLines = contributors
      .map((verdict) => {
        const strongest = [...verdict.evidence].sort((a, b) => b.strength - a.strength)[0];
        return strongest ? strongest.statement.replace(/\.$/, '') : null;
      })
      .filter((line): line is string => line !== null)
      .slice(0, 4);

    const citations = topCitations(contributors, this.config.maxCitationsPerVerdict);
    const concepts = topConcepts(contributors);

    const sourceNames = [...new Set(citations.map((c) => c.sourceTitle))].slice(0, 3);
    const conflictNote =
      crossCheck.conflicts.length > 0
        ? ` This reading is contested: ${crossCheck.conflicts[0].detail} ${crossCheck.conflicts[0].resolution}`
        : '';

    const draft =
      `${status} on ${understood.market.symbol} (${understood.timeframe}) at ${(confidence * 100).toFixed(0)}% confidence, ` +
      `corroborated by ${contributors.length} independent agents: ${contributors.map((c) => label(c.agent)).join(', ')}. ` +
      `${evidenceLines.join('. ')}.` +
      (sourceNames.length > 0 ? ` Grounded in ${sourceNames.join(', ')}.` : '') +
      conflictNote +
      ' This is an observation of current market state, not advice.';

    // Enforcement runs on the deterministic draft too. The composition above
    // is written to be observational, but the same rule set must apply to
    // every path out of the system, not only the generated ones.
    const { clean, violations } = enforceVocabulary(draft);
    if (violations.length > 0) {
      this.logger.warn(
        `deterministic composition contained ${violations.length} directive phrase(s) (${violations.join(', ')}) — rewritten`,
      );
    }

    return {
      status,
      content: clean,
      confidence: Number(confidence.toFixed(4)),
      pattern: patternFor(contributors, stance),
      citations,
      supportingConcepts: concepts,
      disclaimer: SI_DISCLAIMER,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct testing.
// ---------------------------------------------------------------------------

/**
 * Status headline from the allowed vocabulary.
 *
 * Mirrors `vocabulary.ts`'s phrasing rather than importing `statusHeadline`,
 * because that function keys off the orchestrator's `MarketStateValue` state
 * machine and this engine has no state machine — it answers one request at a
 * time. Reusing the phrasing keeps the two surfaces consistent to a reader.
 */
export function statusFor(stance: Stance, symbol: string): string {
  switch (stance) {
    case 'bullish':
      return 'Bullish side in focus';
    case 'bearish':
      return 'Bearish side in focus';
    case 'risk-elevated':
      return 'Risk awareness';
    case 'neutral':
      return 'Structure developing — no side in focus';
    default:
      return `Observing ${symbol}`;
  }
}

/** Name the pattern this observation is about, for the audit trail and UI. */
export function patternFor(contributors: AgentVerdict[], stance: Stance): string {
  const strategy = contributors.find((c) => c.agent === 'strategy-intelligence');
  if (strategy && strategy.supportingConcepts.length > 0) return strategy.supportingConcepts[0].conceptId;

  const trap = contributors.find((c) => c.agent === 'trap-intelligence');
  if (trap && trap.supportingConcepts.length > 0) return trap.supportingConcepts[0].conceptId;

  const anyConcept = contributors.flatMap((c) => c.supportingConcepts)[0];
  return anyConcept?.conceptId ?? stance.replace(/-/g, '_');
}

/**
 * Best citations across contributors, one document at a time.
 *
 * Round-robin by source rather than straight top-N by relevance: eight
 * passages from one book is one author's view repeated, and presenting it as
 * the grounding for a corroborated observation would overstate the evidence.
 */
export function topCitations(contributors: AgentVerdict[], limit: number): KnowledgeCitation[] {
  const bySource = new Map<string, KnowledgeCitation[]>();
  for (const verdict of contributors) {
    for (const citation of verdict.citations) {
      const bucket = bySource.get(citation.sourceId) ?? [];
      if (!bucket.some((c) => c.chunkId === citation.chunkId)) bucket.push(citation);
      bySource.set(citation.sourceId, bucket);
    }
  }

  for (const bucket of bySource.values()) bucket.sort((a, b) => b.relevance - a.relevance);

  const out: KnowledgeCitation[] = [];
  let round = 0;
  while (out.length < limit) {
    let added = false;
    for (const bucket of bySource.values()) {
      if (round >= bucket.length) continue;
      out.push(bucket[round]);
      added = true;
      if (out.length === limit) break;
    }
    if (!added) break;
    round++;
  }
  return out.sort((a, b) => b.relevance - a.relevance);
}

/** Highest-weight supporting concepts across contributors, deduped. */
export function topConcepts(contributors: AgentVerdict[], limit = 5): SupportingConcept[] {
  const byId = new Map<string, SupportingConcept>();
  for (const verdict of contributors) {
    for (const concept of verdict.supportingConcepts) {
      const existing = byId.get(concept.conceptId);
      if (!existing || concept.weight > existing.weight) byId.set(concept.conceptId, concept);
    }
  }
  return [...byId.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

function label(agent: string): string {
  return agent.replace(/-intelligence$/, '').replace(/-/g, ' ');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
