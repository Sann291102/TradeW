import { Injectable, Logger } from '@nestjs/common';
import { HistoricalSimilarityService, HistoricalSimilarityResult } from '../brain/historical-similarity.service';
import { StrategyIntelligenceService, BaseRateResult } from '../brain/strategy-intelligence.service';
import { StrategyDefinition } from '../intelligence/strategy-engine.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { PsychologyIntelligenceService } from './psychology-intelligence.service';
import { RegimeIntelligenceService } from './regime-intelligence.service';
import { SimilarityService } from './similarity.service';
import { RankedKnowledge, Regime } from './types';

export interface StrategyKnowledgeRequest {
  strategyId: string;
  strategyName: string;
  bias?: 'bullish' | 'bearish' | 'neutral';
  symbol?: string;
  regime?: Regime | null;
  /** Rules that already confirmed on the current setup (for terminology reuse). */
  rulesMatched?: string[];
  /** Rules that would invalidate this strategy. */
  invalidations?: string[];
}

export interface StrategyKnowledgePayload {
  strategyId: string;
  strategyName: string;
  similarStrategies: RankedKnowledge[];
  requiredConfirmations: RankedKnowledge[];
  failureConditions: RankedKnowledge[];
  psychologyConsiderations: RankedKnowledge[];
  regimeSuitability: RankedKnowledge[];
  riskConsiderations: RankedKnowledge[];
  /** Historical base rate across all symbols for this strategy/pattern. */
  baseRate: BaseRateResult | null;
  /** Historical similarity for the specific symbol, if one was supplied. */
  historical: HistoricalSimilarityResult | null;
  latencyMs: number;
}

const REQUIRED_CONFIRMATION_QUERY_SUFFIX = ' confirmations and required evidence';
const FAILURE_QUERY_SUFFIX = ' invalidation, failure modes, false signals';
const RISK_QUERY_SUFFIX = ' risk management, position sizing, stop placement';

/**
 * Strategy Knowledge Service — enriches a detected strategy with every
 * facet of Brain knowledge a runtime consumer needs to explain it.
 *
 * This is composition, not new intelligence: the Similarity, Retrieval,
 * Psychology and Regime services do the actual lookups, and Historical
 * Similarity + Strategy Intelligence (both pre-existing) provide the
 * quantitative backdrop. The service's job is to package the facets
 * consistently so an explanation always has the same seven slots to
 * render — never a shape that changes based on which data was available.
 *
 * No output crosses the buy/sell line. Every facet describes what to
 * *understand*, not what to *do*.
 */
@Injectable()
export class StrategyKnowledgeService {
  private readonly logger = new Logger(StrategyKnowledgeService.name);

  constructor(
    private readonly similarity: SimilarityService,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly psychology: PsychologyIntelligenceService,
    private readonly regime: RegimeIntelligenceService,
    private readonly baseRates: StrategyIntelligenceService,
    private readonly historical: HistoricalSimilarityService,
  ) {}

  async describe(request: StrategyKnowledgeRequest): Promise<StrategyKnowledgePayload> {
    const started = Date.now();
    const name = request.strategyName;
    const readableName = readable(name);
    const invalidationTerms = (request.invalidations ?? []).map(readable).join(', ');

    const [
      similarStrategies,
      requiredConfirmations,
      failureConditions,
      regimeSuitability,
      riskConsiderations,
      baseRate,
      historical,
    ] = await Promise.all([
      this.similarity.similar('strategy', readableName, { limit: 4 }).then((r) => r.neighbours),
      this.retrieval
        .retrieve({ query: `${readableName}${REQUIRED_CONFIRMATION_QUERY_SUFFIX}`, limit: 5 })
        .then((r) => r.items),
      this.retrieval
        .retrieve({
          query: `${readableName}${FAILURE_QUERY_SUFFIX}${invalidationTerms ? '; ' + invalidationTerms : ''}`,
          limit: 5,
        })
        .then((r) => r.items),
      this.regime.knowledgeFor(request.regime ?? null, { limit: 4, extraQuery: readableName }),
      this.retrieval
        .retrieve({
          query: `${readableName}${RISK_QUERY_SUFFIX}`,
          hints: { boostTags: ['domain:risk-management'] },
          limit: 4,
        })
        .then((r) => r.items),
      this.safeBaseRate(request.strategyId),
      request.symbol ? this.safeHistorical(request.symbol, request.strategyId) : Promise.resolve(null),
    ]);

    // Psychology cue seed for the strategy: default set derived from
    // long-standing failure modes for any strategy (patience/discipline)
    // plus bias-specific defaults.
    const psychSeeds = ['patience', 'discipline'];
    if (request.bias === 'bullish') psychSeeds.push('fomo');
    else if (request.bias === 'bearish') psychSeeds.push('loss-aversion');
    const psychologyConsiderations = await this.psychology.knowledgeFor(psychSeeds, { limit: 4 });

    return {
      strategyId: request.strategyId,
      strategyName: request.strategyName,
      similarStrategies,
      requiredConfirmations,
      failureConditions,
      psychologyConsiderations,
      regimeSuitability,
      riskConsiderations,
      baseRate,
      historical,
      latencyMs: Date.now() - started,
    };
  }

  /** Convenience: describe a strategy identified by its `StrategyDefinition`. */
  async describeDefinition(def: StrategyDefinition, symbol?: string, regime?: Regime | null): Promise<StrategyKnowledgePayload> {
    return this.describe({
      strategyId: def.id,
      strategyName: def.name,
      symbol,
      regime: regime ?? null,
      rulesMatched: def.rules,
      invalidations: def.invalidations,
    });
  }

  private async safeBaseRate(patternName: string): Promise<BaseRateResult | null> {
    try {
      return await this.baseRates.baseRateFor(patternName);
    } catch (err) {
      this.logger.warn(`baseRateFor(${patternName}) failed non-fatally: ${(err as Error).message}`);
      return null;
    }
  }

  private async safeHistorical(symbol: string, patternName: string): Promise<HistoricalSimilarityResult | null> {
    try {
      return await this.historical.similarPast(symbol, patternName);
    } catch (err) {
      this.logger.warn(`historical(${symbol}, ${patternName}) failed non-fatally: ${(err as Error).message}`);
      return null;
    }
  }
}

function readable(id: string): string {
  return id.replace(/[_-]+/g, ' ').trim();
}
