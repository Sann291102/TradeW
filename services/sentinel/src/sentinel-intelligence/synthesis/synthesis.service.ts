import { Inject, Injectable, Logger } from '@nestjs/common';
import { enforceVocabulary, hasDirectiveLanguage } from '../../vocabulary/vocabulary';
import { SI_CONFIG, SentinelIntelligenceConfig } from '../si.config';
import type { CrossCheckResult } from './cross-check.service';
import {
  SI_DISCLAIMER,
  type AgentVerdict,
  type KnowledgeCitation,
  type LivePerformanceCheck,
  type Stance,
  type SupportingConcept,
  type SurfacedObservation,
  type SynthesisResult,
  type UnderstoodRequest,
  type VerdictVeto,
} from '../types';

/**
 * The gate.
 *
 * SentinelIntelligence is silent by default. An observation is surfaced only
 * when ALL of these hold:
 *
 *  0. no agent raised a veto,
 *  1. aggregate confidence ≥ the threshold (0.70 by default),
 *  2. at least N non-abstaining agents (2 by default) independently landed on
 *     the leading stance, and
 *  3. for a directional read, the pattern it is about has a live-market track
 *     record behind it.
 *
 * Gate 0 is structurally different from the rest and runs first. Gates 1-4
 * weigh opinions; a veto is not an opinion. The compliance agent raises one
 * when directive language survives the vocabulary rewriter, and that finding
 * has to be able to stop a run on its own — as a weighted stance it was the
 * lowest-weighted voice in the system (0.2 on every intent), so the one agent
 * that exists to hold the observation-only boundary was the one least able to.
 *
 * None substitutes for another, and that is the whole point. One agent at 95%
 * is a single point of failure — an overfit threshold, a stale feed, a bug —
 * and no confidence number makes it corroborated. Two agents at 71% agreeing
 * from different evidence is a genuinely stronger claim than one at 95%.
 *
 * Condition 3 closes a different hole: the agents reason from trading books,
 * and ten agents can agree at high confidence about a setup the book describes
 * beautifully and that has never once resolved in this live market. Confidence
 * measures agreement among readers of the corpus, not whether the corpus is
 * right about this instrument. Only outcome-tagged live occurrences measure
 * that, so a directional read waits for them.
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
    overrides: {
      confidenceThreshold?: number;
      requiredCorroboration?: number;
      /**
       * Live-market track record for the pattern this run is about, resolved
       * by the caller. Passed in rather than looked up here so this service
       * stays a pure, synchronous function over verdicts — the gate must be
       * verifiable with no container, no database and no network.
       */
      livePerformance?: LivePerformanceCheck | null;
    } = {},
  ): SynthesisResult {
    const threshold = clamp01(overrides.confidenceThreshold ?? this.config.confidenceThreshold);
    const requiredCorroboration = Math.max(
      1,
      overrides.requiredCorroboration ?? this.config.requiredCorroboration,
    );

    const livePerformance = overrides.livePerformance ?? null;

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
      livePerformance,
    };

    // ---- gate 0: agent veto (pre-gate) ----------------------------------
    // Checked before anything is weighed, and before the leading stance or the
    // confidence is even consulted. A veto says the run's own text is unsafe
    // to publish; no amount of market agreement changes that, and running the
    // weighting first would only produce a more confident version of the same
    // unpublishable output.
    const veto = firstVeto(verdicts);
    if (veto) {
      this.logger.error(
        `run vetoed by ${veto.agent} (${veto.veto.code}): ${veto.veto.reason} — refusing to surface`,
      );
      return {
        ...base,
        surfaced: false,
        observation: null,
        silenceReason:
          `Withheld on a compliance finding: ${veto.veto.reason}. ` +
          'The observation-only boundary is not a weighted opinion — nothing is surfaced from this run. ' +
          'Monitoring continues.',
      };
    }

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

    // ---- gate 4: live-market performance behind a directional read ------
    // Scoped to bullish/bearish deliberately. A directional read is an
    // implicit "this setup is working" claim and must be earned against live
    // outcomes. A risk-elevated reading makes no such claim — it reports a
    // hazard the agents can see right now — and Sentinel's mandate is
    // behavioural safety, so withholding a corroborated warning until a
    // pattern has accumulated a track record would make the product less safe
    // in exactly the situation it exists for.
    const pattern = resolvePattern(verdicts, crossCheck);
    if (
      this.config.requireLivePerformance &&
      (leadingStance === 'bullish' || leadingStance === 'bearish') &&
      !livePerformance?.reliable
    ) {
      const sample = livePerformance?.sample ?? 0;
      return {
        ...base,
        surfaced: false,
        observation: null,
        silenceReason:
          `The ${pattern.replace(/_/g, ' ')} pattern has ${sample} outcome-tagged occurrence${sample === 1 ? '' : 's'} ` +
          'in live-market memory — too few for its confidence to be reported. ' +
          'Corroborated reasoning is recorded; observation is withheld until the pattern has resolved live enough times. ' +
          'Monitoring continues.',
      };
    }

    const observation = this.compose(understood, verdicts, crossCheck, confidence, pattern);

    // ---- gate 5: compliance backstop on the composed text ----------------
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
    pattern: string,
  ): SurfacedObservation {
    const stance = crossCheck.leadingStance;
    const contributors = contributorsOf(verdicts, crossCheck);

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

    const body =
      `${status} on ${understood.market.symbol} (${understood.timeframe}) at ${(confidence * 100).toFixed(0)}% confidence, ` +
      `corroborated by ${contributors.length} independent agents: ${contributors.map((c) => label(c.agent)).join(', ')}. ` +
      `${evidenceLines.join('. ')}.` +
      (sourceNames.length > 0 ? ` Grounded in ${sourceNames.join(', ')}.` : '') +
      conflictNote;

    // Enforcement runs on the deterministic body too. The composition above is
    // written to be observational, but the same rule set must apply to every
    // path out of the system, not only the generated ones.
    const { clean, violations } = enforceVocabulary(body);
    if (violations.length > 0) {
      this.logger.warn(
        `deterministic composition contained ${violations.length} directive phrase(s) (${violations.join(', ')}) — rewritten`,
      );
    }

    return {
      status,
      // The closing sentence is appended AFTER enforcement, never through it.
      // The enforcer rewrites the noun "advice" into "observation" — which is
      // correct for model prose and destroys this reviewed constant, turning
      // "not advice" into "not observation". A fixed, already-compliant string
      // has nothing to gain from being rewritten and everything to lose.
      content: `${clean} ${OBSERVATION_CLOSER}`,
      confidence: Number(confidence.toFixed(4)),
      // Resolved by the caller so the live-performance gate and this
      // observation are provably talking about the same pattern.
      pattern,
      citations,
      supportingConcepts: concepts,
      disclaimer: SI_DISCLAIMER,
    };
  }
}

/**
 * The fixed closing sentence on every surfaced observation.
 *
 * Kept out of the enforcer's path deliberately — see `compose()`. It is a
 * reviewed constant, not generated text.
 */
export const OBSERVATION_CLOSER = 'This is an observation of current market state, not advice.';

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct testing.
// ---------------------------------------------------------------------------

/**
 * The first veto raised in a run, or null.
 *
 * Exported so the gate tests assert against the same lookup the gate uses.
 * Abstentions are skipped: an agent that declined to answer has, by
 * definition, found nothing to enforce, and an abstention carrying a veto
 * would be a bug in that agent rather than a finding to act on.
 */
export function firstVeto(verdicts: AgentVerdict[]): { agent: string; veto: VerdictVeto } | null {
  for (const verdict of verdicts) {
    if (verdict.veto && !verdict.abstained) return { agent: verdict.agent, veto: verdict.veto };
  }
  return null;
}

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

/**
 * The non-abstaining verdicts that agreed with the leading stance.
 *
 * Shared by the gate and the composition so both reason over exactly the same
 * set — a gate that judged a different set of contributors than the paragraph
 * it lets through would be checking the wrong thing.
 */
export function contributorsOf(verdicts: AgentVerdict[], crossCheck: CrossCheckResult): AgentVerdict[] {
  const agreeing = new Set(
    crossCheck.corroboration.filter((c) => c.stance === crossCheck.leadingStance).map((c) => c.agent),
  );
  return verdicts.filter((v) => agreeing.has(v.agent) && !v.abstained);
}

/**
 * The pattern a run is about, resolved from its cross-check result.
 *
 * The caller resolves this BEFORE synthesis so it can look the pattern's live
 * track record up, and passes both in. Exported so the pipeline and the tests
 * name the pattern the same way the gate does.
 */
export function resolvePattern(verdicts: AgentVerdict[], crossCheck: CrossCheckResult): string {
  return patternFor(contributorsOf(verdicts, crossCheck), crossCheck.leadingStance);
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
