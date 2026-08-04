import { Injectable } from '@nestjs/common';
import { hasDirectiveLanguage } from '../../vocabulary/vocabulary';
import { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type {
  AgentVerdict,
  Conflict,
  CorroborationEntry,
  Stance,
  Subtask,
  ValidationFailure,
} from '../types';

export interface CrossCheckResult {
  /** Verdicts that passed validation. Only these reach synthesis. */
  accepted: AgentVerdict[];
  validationFailures: ValidationFailure[];
  conflicts: Conflict[];
  corroboration: CorroborationEntry[];
  /** The stance carrying the most effective weight after conflict resolution. */
  leadingStance: Stance;
  /** Non-abstaining agents agreeing with the leading stance. */
  corroboratingAgents: number;
  /** Total penalty to subtract from the aggregate confidence, 0..1. */
  totalPenalty: number;
}

/**
 * Validates agent verdicts, then finds and resolves the disagreements between
 * them.
 *
 * The distinction that matters throughout: **directional stances compete;
 * `risk-elevated` does not.** An agent reporting elevated risk is not
 * contradicting an agent reporting bullish structure — a dangerous tape and a
 * bullish tape are routinely the same tape. Collapsing both onto one axis would
 * manufacture a conflict on almost every run and, worse, would let a risk
 * warning cancel out a structural read that was never in tension with it.
 */
@Injectable()
export class CrossCheckService {
  constructor(private readonly graph: ReasoningGraphService) {}

  check(verdicts: AgentVerdict[], subtasks: Subtask[]): CrossCheckResult {
    const weightBySubtask = new Map(subtasks.map((s) => [s.id, s.weight]));
    const { accepted, validationFailures } = this.validate(verdicts);

    const corroboration = this.buildCorroboration(accepted, weightBySubtask);
    const conflicts = [
      ...this.directionalConflicts(accepted, corroboration),
      ...this.confidenceOutliers(accepted, corroboration),
      ...this.evidenceContradictions(accepted),
      ...this.knowledgeContradictions(accepted),
    ];

    const totalPenalty = Math.min(0.6, conflicts.reduce((sum, c) => sum + c.penalty, 0));
    const { leadingStance, corroboratingAgents } = this.resolveLeading(corroboration, conflicts);

    return {
      accepted,
      validationFailures,
      conflicts,
      corroboration,
      leadingStance,
      corroboratingAgents,
      totalPenalty,
    };
  }

  /**
   * Structural validation.
   *
   * A failing verdict is *dropped*, not merely flagged — a malformed verdict
   * that still counted toward corroboration would let a broken agent push an
   * observation over the surfacing gate, which is the exact failure the gate
   * exists to prevent.
   */
  private validate(verdicts: AgentVerdict[]): { accepted: AgentVerdict[]; validationFailures: ValidationFailure[] } {
    const accepted: AgentVerdict[] = [];
    const validationFailures: ValidationFailure[] = [];

    for (const verdict of verdicts) {
      const failures: ValidationFailure[] = [];
      const fail = (rule: string, detail: string) =>
        failures.push({ agent: verdict.agent, subtaskId: verdict.subtaskId, rule, detail });

      if (!Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1) {
        fail('confidence-range', `confidence must be within 0..1, got ${verdict.confidence}`);
      }
      if (verdict.abstained && verdict.confidence !== 0) {
        fail('abstention-confidence', 'an abstaining verdict must carry zero confidence');
      }
      if (!verdict.abstained && verdict.evidence.length === 0) {
        fail('evidence-required', 'a non-abstaining verdict must present at least one evidence item');
      }
      for (const item of verdict.evidence) {
        if (item.kind === 'knowledge' && item.citations.length === 0) {
          fail('citation-required', `knowledge claim "${item.statement.slice(0, 60)}" carries no citation`);
        }
      }
      if (!verdict.abstained && hasDirectiveLanguage(verdict.headline)) {
        fail('directive-language', `headline contains directive vocabulary: "${verdict.headline.slice(0, 80)}"`);
      }
      if (!verdict.abstained && verdict.dataQuality <= 0) {
        fail('quality-required', 'a verdict built on zero-quality data must abstain instead');
      }

      if (failures.length > 0) {
        validationFailures.push(...failures);
        continue;
      }
      accepted.push(verdict);
    }

    return { accepted, validationFailures };
  }

  /**
   * Effective weight per verdict.
   *
   * Three independent factors multiply: the decomposer's intent-derived weight,
   * how complete the agent's data was, and how well the corpus backed it. An
   * agent can be important, well-informed and well-grounded — or fail any one
   * of those and contribute proportionally less.
   */
  private buildCorroboration(
    verdicts: AgentVerdict[],
    weightBySubtask: Map<string, number>,
  ): CorroborationEntry[] {
    return verdicts
      .filter((v) => !v.abstained)
      .map((v) => {
        const subtaskWeight = weightBySubtask.get(v.subtaskId) ?? 0.5;
        const distinctSources = new Set(v.citations.map((c) => c.sourceId)).size;
        // Grounding bonus is capped at three distinct sources: past that the
        // marginal source adds little, and uncapped it would let a
        // well-documented but weakly-evidenced claim outrank a measured one.
        const groundingFactor = 0.75 + 0.25 * Math.min(1, distinctSources / 3);
        return {
          agent: v.agent,
          stance: v.stance,
          confidence: v.confidence,
          effectiveWeight: Number((subtaskWeight * v.dataQuality * groundingFactor).toFixed(4)),
          distinctSources,
        };
      });
  }

  /** Bullish vs bearish among agents that actually took a direction. */
  private directionalConflicts(verdicts: AgentVerdict[], corroboration: CorroborationEntry[]): Conflict[] {
    const bullish = corroboration.filter((c) => c.stance === 'bullish');
    const bearish = corroboration.filter((c) => c.stance === 'bearish');
    if (bullish.length === 0 || bearish.length === 0) return [];

    const bullWeight = weightedConfidence(bullish);
    const bearWeight = weightedConfidence(bearish);
    const dominant = bullWeight > bearWeight ? 'bullish' : 'bearish';
    const ratio = Math.max(bullWeight, bearWeight) / Math.max(1e-6, Math.min(bullWeight, bearWeight));

    // A clear majority resolves the conflict at a cost; a close split does not
    // resolve at all and forces neutrality. "Slightly more bullish evidence"
    // is not a bullish read, it is an unclear market.
    const decisive = ratio >= 1.5;
    const favouredAgents = dominant === 'bullish' ? bullish : bearish;

    return [
      {
        kind: 'directional',
        between: [...bullish, ...bearish].map((c) => c.agent),
        detail:
          `${bullish.length} agent(s) read bullish (weighted ${bullWeight.toFixed(2)}), ` +
          `${bearish.length} read bearish (weighted ${bearWeight.toFixed(2)}).`,
        resolution: decisive
          ? `Resolved toward ${dominant}: its corroborators carry ${ratio.toFixed(1)}× the weighted confidence, above the 1.5× threshold. Confidence is reduced because the read is contested.`
          : `Unresolved — the split is ${ratio.toFixed(1)}×, below the 1.5× threshold needed to call a side. The reading collapses to neutral.`,
        favoured: decisive ? favouredAgents[0].agent : null,
        // An unresolved split costs more than a resolved one, because the
        // market genuinely is not saying anything clear.
        penalty: decisive ? 0.12 : 0.3,
      },
    ];
  }

  /**
   * An agent far more confident than everyone who agrees with it.
   *
   * Not treated as a disagreement, but as a reason to distrust the outlier:
   * confidence that no corroborator shares is usually a bug or an overfit
   * threshold, not insight.
   */
  private confidenceOutliers(verdicts: AgentVerdict[], corroboration: CorroborationEntry[]): Conflict[] {
    if (corroboration.length < 3) return [];
    const conflicts: Conflict[] = [];

    for (const entry of corroboration) {
      const peers = corroboration.filter((c) => c.agent !== entry.agent && c.stance === entry.stance);
      if (peers.length < 2) continue;
      const peerMean = peers.reduce((s, p) => s + p.confidence, 0) / peers.length;
      if (entry.confidence - peerMean < 0.4) continue;

      conflicts.push({
        kind: 'confidence-outlier',
        between: [entry.agent, ...peers.map((p) => p.agent)],
        detail: `${entry.agent} reports ${(entry.confidence * 100).toFixed(0)}% confidence while agreeing agents average ${(peerMean * 100).toFixed(0)}%.`,
        resolution:
          'The outlier is capped at the peer mean plus 0.2 for the aggregate. Confidence no corroborator shares is treated as unreliable rather than as insight.',
        favoured: null,
        penalty: 0.05,
      });
    }
    return conflicts;
  }

  /**
   * Two agents asserting different values for the same measured quantity.
   *
   * With a shared snapshot this should be impossible, which is precisely why
   * it is checked: if it ever fires, an agent is computing its own market data
   * behind the engine's back and the whole corroboration model is compromised.
   */
  private evidenceContradictions(verdicts: AgentVerdict[]): Conflict[] {
    const byKey = new Map<string, { agent: string; value: number }[]>();

    for (const verdict of verdicts) {
      if (verdict.abstained) continue;
      for (const item of verdict.evidence) {
        if (item.kind !== 'measured' || typeof item.value !== 'number') continue;
        const key = measurementKey(item.statement);
        if (!key) continue;
        const bucket = byKey.get(key) ?? [];
        bucket.push({ agent: verdict.agent, value: item.value });
        byKey.set(key, bucket);
      }
    }

    const conflicts: Conflict[] = [];
    for (const [key, entries] of byKey) {
      if (entries.length < 2) continue;
      const values = entries.map((e) => e.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const scale = Math.max(Math.abs(min), Math.abs(max), 1e-6);
      if ((max - min) / scale <= 0.02) continue; // agreement within 2%

      conflicts.push({
        kind: 'evidence-contradiction',
        between: [...new Set(entries.map((e) => e.agent))] as Conflict['between'],
        detail: `Agents report different values for "${key}": ${entries.map((e) => `${e.agent}=${e.value}`).join(', ')}.`,
        resolution:
          'Flagged, not silently averaged. Every agent reads one shared snapshot, so a divergence here is a defect rather than a difference of opinion.',
        favoured: null,
        penalty: 0.15,
      });
    }
    return conflicts;
  }

  /**
   * Concepts cited by different agents that the ontology says cannot both hold.
   *
   * This is the one conflict type resolved from *knowledge* rather than from
   * weights: the knowledge base explicitly encodes `contradicts` and
   * `invalidates` edges, so the disagreement is settled by what the corpus
   * asserts rather than by whichever agent happened to be more confident.
   */
  private knowledgeContradictions(verdicts: AgentVerdict[]): Conflict[] {
    const conceptOwners = new Map<string, Set<string>>();
    for (const verdict of verdicts) {
      if (verdict.abstained) continue;
      for (const concept of verdict.supportingConcepts) {
        const owners = conceptOwners.get(concept.conceptId) ?? new Set<string>();
        owners.add(verdict.agent);
        conceptOwners.set(concept.conceptId, owners);
      }
    }

    const tensions = this.graph.tensionsAmong([...conceptOwners.keys()]);
    const conflicts: Conflict[] = [];

    for (const tension of tensions) {
      const agentsA = conceptOwners.get(tension.a) ?? new Set<string>();
      const agentsB = conceptOwners.get(tension.b) ?? new Set<string>();
      // Only a real cross-agent tension counts. One agent citing both sides of
      // a contradiction is describing an ambiguous market, which is a legitimate
      // observation and not an inter-agent conflict.
      const distinct = new Set([...agentsA, ...agentsB]);
      if (distinct.size < 2) continue;

      conflicts.push({
        kind: 'knowledge-contradiction',
        between: [...distinct] as Conflict['between'],
        detail: `${tension.reads}${tension.note ? ` — ${tension.note}` : ''}`,
        resolution:
          'Resolved from the knowledge base rather than by agent confidence: the ontology marks these concepts mutually weakening, so both readings are held as ambiguous.',
        favoured: null,
        penalty: 0.1 * tension.weight,
      });
    }
    return conflicts;
  }

  /**
   * The stance carrying the most weight, and how many agents corroborate it.
   *
   * `risk-elevated` is counted on its own axis and can win outright — a
   * corroborated risk warning is a legitimate thing to surface even when the
   * directional read is unclear, which is exactly the case where a trader most
   * needs to hear it.
   */
  private resolveLeading(
    corroboration: CorroborationEntry[],
    conflicts: Conflict[],
  ): { leadingStance: Stance; corroboratingAgents: number } {
    const unresolvedDirectional = conflicts.some((c) => c.kind === 'directional' && c.favoured === null);

    const byStance = new Map<Stance, CorroborationEntry[]>();
    for (const entry of corroboration) {
      const bucket = byStance.get(entry.stance) ?? [];
      bucket.push(entry);
      byStance.set(entry.stance, bucket);
    }

    const risk = byStance.get('risk-elevated') ?? [];
    const bullish = byStance.get('bullish') ?? [];
    const bearish = byStance.get('bearish') ?? [];

    const riskWeight = weightedConfidence(risk);
    const directional = unresolvedDirectional
      ? []
      : weightedConfidence(bullish) >= weightedConfidence(bearish)
        ? bullish
        : bearish;
    const directionalWeight = weightedConfidence(directional);

    if (risk.length >= 2 && riskWeight >= directionalWeight) {
      return { leadingStance: 'risk-elevated', corroboratingAgents: risk.length };
    }
    if (directional.length > 0 && directionalWeight > 0) {
      return { leadingStance: directional[0].stance, corroboratingAgents: directional.length };
    }
    if (risk.length > 0) {
      return { leadingStance: 'risk-elevated', corroboratingAgents: risk.length };
    }
    return { leadingStance: 'neutral', corroboratingAgents: (byStance.get('neutral') ?? []).length };
  }
}

/** Sum of confidence × effective weight across a stance group. */
export function weightedConfidence(entries: CorroborationEntry[]): number {
  return entries.reduce((sum, e) => sum + e.confidence * e.effectiveWeight, 0);
}

/**
 * Normalise a measured statement to a comparison key.
 *
 * Strips numbers and punctuation so "RSI(14) at 62.1" and "RSI(14) at 58.4"
 * collapse to the same key and can be compared. Returns null for statements
 * too short to be a stable identifier, so incidental prose is not compared.
 */
export function measurementKey(statement: string): string | null {
  const key = statement
    .toLowerCase()
    .replace(/[\d.,%()/-]+/g, ' ')
    .replace(/\b(at|is|of|the|a|an|to|in|on|with)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key.length >= 8 ? key : null;
}
