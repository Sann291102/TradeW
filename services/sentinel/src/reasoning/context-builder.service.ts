import { Injectable } from '@nestjs/common';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { PsychologyIntelligenceService } from './psychology-intelligence.service';
import { RegimeIntelligenceService } from './regime-intelligence.service';
import { ContextInput, RankedKnowledge, ReasoningContext } from './types';

/**
 * Runtime Context Builder — takes a partial description of the current
 * market/session and returns a fully-hydrated reasoning context.
 *
 * The builder is deliberately tolerant of missing fields: an intraday
 * caller might have only a symbol and a pattern; an end-of-day review might
 * have every field including psychology cues. Whichever slots are present
 * feed into the corresponding retrieval, and empty slots are simply empty
 * in the output — no fabricated defaults, no invented placeholder concepts.
 *
 * Every retrieval is parallelised so the overall build cost is bounded by
 * the slowest single retrieval, not their sum.
 */
@Injectable()
export class ReasoningContextBuilderService {
  constructor(
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly psychology: PsychologyIntelligenceService,
    private readonly regime: RegimeIntelligenceService,
  ) {}

  async build(input: ContextInput): Promise<ReasoningContext> {
    const started = Date.now();
    const synthesis = synthesise(input);
    const detectedRegime = this.regime.classify(input.marketRegime ?? null);

    const marketQuery = buildMarketQuery(input);
    const strategyQuery = input.patternName ? `${input.patternName} strategy: confirmations and failure` : '';
    const psychologySeed = input.psychologyCues ?? this.psychology.detect(synthesis).map((d) => d.cue);

    const [marketKnowledge, strategyKnowledge, psychologyKnowledge, regimeKnowledge] = await Promise.all([
      marketQuery
        ? this.retrieval.retrieve({ query: marketQuery, limit: 6, hints: { userId: input.userId ?? null } }).then((r) => r.items)
        : Promise.resolve([] as RankedKnowledge[]),
      strategyQuery
        ? this.retrieval.retrieve({ query: strategyQuery, limit: 5 }).then((r) => r.items)
        : Promise.resolve([] as RankedKnowledge[]),
      psychologySeed.length > 0
        ? this.psychology.knowledgeFor(psychologySeed, { limit: 5 })
        : Promise.resolve([] as RankedKnowledge[]),
      detectedRegime
        ? this.regime.knowledgeFor(detectedRegime, { limit: 5, extraQuery: input.symbol })
        : Promise.resolve([] as RankedKnowledge[]),
    ]);

    return {
      input,
      synthesis,
      marketKnowledge,
      strategyKnowledge,
      psychologyKnowledge,
      regimeKnowledge,
      latencyMs: Date.now() - started,
    };
  }
}

function synthesise(input: ContextInput): string {
  const parts: string[] = [];
  if (input.symbol) parts.push(`Symbol ${input.symbol}`);
  if (input.timeframe) parts.push(`timeframe ${input.timeframe}`);
  if (input.marketRegime) parts.push(`regime described as ${input.marketRegime}`);
  if (input.patternName) parts.push(`active pattern ${input.patternName}`);
  if (input.indicators && input.indicators.length > 0) parts.push(`indicators: ${input.indicators.join('; ')}`);
  if (input.recentMemory && input.recentMemory.length > 0) parts.push(`recent memory: ${input.recentMemory.join('; ')}`);
  if (input.psychologyCues && input.psychologyCues.length > 0) parts.push(`psychology cues: ${input.psychologyCues.join(', ')}`);
  return parts.length > 0 ? parts.join('. ') + '.' : 'No context provided.';
}

function buildMarketQuery(input: ContextInput): string {
  const parts: string[] = [];
  if (input.symbol) parts.push(input.symbol);
  if (input.marketRegime) parts.push(input.marketRegime);
  if (input.patternName) parts.push(input.patternName);
  if (input.indicators && input.indicators.length > 0) parts.push(input.indicators.join(' '));
  return parts.join(' ').trim();
}
