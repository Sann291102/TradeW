import { Injectable } from '@nestjs/common';
import { enforceVocabulary } from '../vocabulary/vocabulary';
import { ReasoningContextBuilderService } from './context-builder.service';
import { PsychologyIntelligenceService } from './psychology-intelligence.service';
import { StrategyKnowledgeService } from './strategy-knowledge.service';
import { ContextInput, ExplanationDraft, RankedKnowledge, ReasoningContext } from './types';

const MAX_SECTION_ITEMS = 5;

/**
 * Runtime Explanation Engine — turns a ReasoningContext into an
 * educational, non-directive explanation.
 *
 * Deterministic on purpose. No LLM is called from here — that would
 * require its own guardrails, retries, and cost budget, and this phase's
 * job is to prove that *knowledge-driven* reasoning improves the
 * explanations at all. Every string in the output is either the caller's
 * own input or a `summary` field pulled from the Brain; nothing is
 * invented and nothing is embedded. The `enforceVocabulary` pass is still
 * run on every user-facing string as a defence-in-depth measure — a
 * concept that slipped a directive phrase past the ontology lint cannot
 * reach a user through this engine.
 *
 * A prose layer that consumes an ExplanationDraft and renders it through
 * an LLM is a legitimate future addition; that layer would sit atop this
 * service, not replace it.
 */
@Injectable()
export class ExplanationEngineService {
  constructor(
    private readonly builder: ReasoningContextBuilderService,
    private readonly psychology: PsychologyIntelligenceService,
    private readonly strategyKnowledge: StrategyKnowledgeService,
  ) {}

  async explain(input: ContextInput): Promise<{ context: ReasoningContext; draft: ExplanationDraft }> {
    const context = await this.builder.build(input);
    const draft = this.drawFromContext(context);
    return { context, draft };
  }

  /**
   * Given a pre-built context, produce the deterministic draft. Split out
   * so tests can inject a hand-crafted context without hitting the Brain.
   */
  drawFromContext(context: ReasoningContext): ExplanationDraft {
    const { input } = context;

    const headline = clean(buildHeadline(input));
    const why = clean(buildWhy(context));
    const supportingConcepts = topSummaries(context.marketKnowledge.concat(context.strategyKnowledge), MAX_SECTION_ITEMS);
    const relatedPsychology = topSummaries(context.psychologyKnowledge, MAX_SECTION_ITEMS);
    const riskAwareness = topSummaries(
      context.regimeKnowledge.concat(context.strategyKnowledge.filter((k) => k.hit.record.tags.includes('domain:risk-management'))),
      MAX_SECTION_ITEMS,
    );
    const failureScenarios = topSummaries(
      context.strategyKnowledge.filter((k) => hasAny(k.hit.record.tags, ['domain:patterns', 'concept:false-breakout', 'concept:bull-trap', 'concept:bear-trap'])),
      MAX_SECTION_ITEMS,
    );
    const learningReferences = topSummaries(context.marketKnowledge.filter((k) => k.hit.record.tags.includes('source:book')), MAX_SECTION_ITEMS);

    return {
      headline,
      why,
      supportingConcepts,
      relatedPsychology,
      riskAwareness,
      failureScenarios,
      learningReferences,
      deterministic: true,
    };
  }

  /**
   * One-shot for a detected strategy: builds a strategy-focused explanation
   * without requiring the caller to assemble a ContextInput themselves.
   */
  async explainStrategy(request: {
    strategyId: string;
    strategyName: string;
    symbol?: string;
    regime?: ContextInput['marketRegime'];
    bias?: 'bullish' | 'bearish' | 'neutral';
    indicators?: string[];
  }): Promise<ExplanationDraft> {
    const payload = await this.strategyKnowledge.describe({
      strategyId: request.strategyId,
      strategyName: request.strategyName,
      symbol: request.symbol,
      bias: request.bias,
      regime: null,
    });
    const context: ReasoningContext = {
      input: {
        symbol: request.symbol,
        patternName: request.strategyName,
        marketRegime: request.regime,
        indicators: request.indicators,
      },
      synthesis: `Detected strategy ${request.strategyName} on ${request.symbol ?? 'unspecified symbol'}.`,
      marketKnowledge: payload.regimeSuitability,
      strategyKnowledge: payload.requiredConfirmations.concat(payload.similarStrategies),
      psychologyKnowledge: payload.psychologyConsiderations,
      regimeKnowledge: payload.regimeSuitability,
      latencyMs: 0,
    };
    const draft = this.drawFromContext(context);
    // Weave in the historical / base-rate lines when present — they are
    // authoritative context that Brain retrieval does not produce.
    const extras: string[] = [];
    if (payload.baseRate) extras.push(baseRateLine(payload.baseRate));
    if (payload.historical) extras.push(historicalLine(payload.historical));
    if (extras.length > 0) draft.why = clean(`${draft.why} ${extras.join(' ')}`.trim());
    return draft;
  }
}

function buildHeadline(input: ContextInput): string {
  const parts: string[] = [];
  parts.push(input.patternName ? `Discussion — ${input.patternName}` : 'Discussion');
  if (input.symbol) parts.push(`on ${input.symbol}`);
  if (input.marketRegime) parts.push(`(${input.marketRegime})`);
  return parts.join(' ');
}

function buildWhy(context: ReasoningContext): string {
  const { input } = context;
  const parts: string[] = [context.synthesis];
  const counts = {
    market: context.marketKnowledge.length,
    strategy: context.strategyKnowledge.length,
    psychology: context.psychologyKnowledge.length,
    regime: context.regimeKnowledge.length,
  };
  parts.push(
    `Brain retrieval returned ${counts.market} market, ${counts.strategy} strategy, ${counts.psychology} psychology and ${counts.regime} regime memory record(s) relevant to this context.`,
  );
  if (input.psychologyCues && input.psychologyCues.length > 0) {
    parts.push(`Psychology cues flagged: ${input.psychologyCues.join(', ')} — these frame how the current setup should be interpreted.`);
  }
  return parts.join(' ');
}

function topSummaries(items: RankedKnowledge[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (out.length >= limit) break;
    const s = item.hit.record.summary;
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(clean(s));
  }
  return out;
}

function hasAny(tags: string[], candidates: string[]): boolean {
  const set = new Set(tags);
  for (const c of candidates) if (set.has(c)) return true;
  return false;
}

function clean(text: string): string {
  const { clean: cleaned } = enforceVocabulary(text);
  return cleaned;
}

function baseRateLine(baseRate: { pattern: string; sample: number; distribution: Record<string, number>; reliable: boolean }): string {
  if (baseRate.sample === 0) return `No outcome-tagged occurrences of ${baseRate.pattern.replace(/_/g, ' ')} in memory yet.`;
  if (!baseRate.reliable) return `${baseRate.sample} outcome-tagged occurrence(s) — too few to report a reliable base rate yet.`;
  const total = Object.values(baseRate.distribution).reduce((a, b) => a + b, 0);
  const parts = Object.entries(baseRate.distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${Math.round((v / total) * 100)}%`);
  return `Historical base rate across all symbols: ${parts.join(', ')}.`;
}

function historicalLine(h: { symbol: string; occurrences: number; withKnownOutcome: number; sampleTooSmall: boolean; outcomeCounts: Record<string, number> }): string {
  if (h.occurrences === 0) return `No prior occurrences of this pattern on ${h.symbol} in memory yet.`;
  if (h.sampleTooSmall) return `${h.occurrences} prior occurrence(s) on ${h.symbol}, but too few with a known outcome (${h.withKnownOutcome}) to report a reliable frequency.`;
  const total = Object.values(h.outcomeCounts).reduce((a, b) => a + b, 0);
  const parts = Object.entries(h.outcomeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${Math.round((v / total) * 100)}%`);
  return `On ${h.symbol}: ${parts.join(', ')} across ${h.withKnownOutcome} outcomes.`;
}
