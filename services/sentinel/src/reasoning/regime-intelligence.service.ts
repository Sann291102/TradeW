import { Injectable } from '@nestjs/common';
import { MarketProfile } from '../domain';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { RankedKnowledge, Regime, REGIMES } from './types';

/**
 * Regime Intelligence — classifies the current market state into one of
 * eight canonical regimes and produces regime-appropriate boosts for the
 * ranker.
 *
 * The classification is a mapping over the existing `MarketProfile` (which
 * the Market Intelligence engine already produces on every observation),
 * not a re-analysis of the snapshot. That keeps this service composable
 * with the existing observation flow without adding a second, potentially
 * disagreeing classifier.
 *
 * Callers can pass a free-form regime string too — the resolver falls
 * back to keyword matching so an orchestrator that already speaks in
 * `"volatile"` or `"accumulation"` doesn't need to import types from here.
 */
@Injectable()
export class RegimeIntelligenceService {
  constructor(private readonly retrieval: KnowledgeRetrievalService) {}

  /**
   * Resolve a `MarketProfile` (or free-text regime label) into one of the
   * canonical regimes. Returns null when no confident classification is
   * possible — callers should then fall back to symbol-level retrieval
   * rather than boost the wrong concept set.
   */
  classify(input: MarketProfile | string | null | undefined): Regime | null {
    if (!input) return null;
    if (typeof input === 'string') return matchRegime(input);
    return regimeFromProfile(input);
  }

  /**
   * Tag boosts to feed the ranker so retrieval leans toward the concepts
   * that most inform reasoning in this regime. Never a filter — a regime
   * boost only *raises* matching records; it never hides the rest.
   */
  boostTagsFor(regime: Regime | null): string[] {
    if (!regime) return [];
    switch (regime) {
      case 'trending':
        return ['domain:market-structure', 'concept:trend', 'concept:trend-day'];
      case 'ranging':
        return ['domain:market-structure', 'concept:trading-range', 'concept:mean-reversion'];
      case 'volatile':
        return ['domain:options', 'concept:implied-volatility', 'concept:iv-crush', 'topic:volatility'];
      case 'low-volatility':
        return ['domain:market-structure', 'concept:low-volume-breakout', 'concept:accumulation'];
      case 'breakout':
        return ['domain:price-action', 'concept:breakout', 'concept:range-expansion', 'concept:false-breakout'];
      case 'mean-reversion':
        return ['concept:mean-reversion', 'concept:trading-range', 'domain:market-structure'];
      case 'accumulation':
        return ['concept:accumulation', 'domain:institutional-concepts', 'concept:institutional-order-flow'];
      case 'distribution':
        return ['concept:distribution', 'domain:institutional-concepts', 'concept:institutional-order-flow'];
    }
  }

  async knowledgeFor(regime: Regime | null, opts: { limit?: number; extraQuery?: string } = {}): Promise<RankedKnowledge[]> {
    if (!regime) return [];
    const boostTags = this.boostTagsFor(regime);
    const query = `${regime.replace('-', ' ')} regime ${opts.extraQuery ?? ''}`.trim();
    const result = await this.retrieval.retrieve({
      query,
      hints: { boostTags },
      limit: opts.limit ?? 6,
    });
    return result.items;
  }
}

/**
 * Exported so `MarketBehaviourService` can classify a regime without
 * instantiating this service and dragging in `KnowledgeRetrievalService`.
 * Deliberately the SAME function rather than a second implementation — this
 * file's whole premise is that there is one classifier, not two that can
 * disagree.
 */
export function regimeFromProfile(profile: MarketProfile): Regime | null {
  switch (profile.type) {
    case 'Bullish Trend Day':
    case 'Bearish Trend Day':
    case 'Rally Continuation':
    case 'Descent Continuation':
      return 'trending';
    case 'High Volatility Range':
      return 'volatile';
    case 'Low Volatility Compression':
    case 'Inside Day':
      return 'low-volatility';
    case 'Gap & Go':
    case 'Outside Day / Expansion':
      return 'breakout';
    case 'Gap Fill / Mean Reversion':
      return 'mean-reversion';
    default:
      // Fall back to the structural read if the type is unknown.
      if (profile.structure === 'trending') return 'trending';
      if (profile.structure === 'ranging') return 'ranging';
      if (profile.structure === 'breaking-out') return 'breakout';
      if (profile.structure === 'consolidating') return 'low-volatility';
      return null;
  }
}

function matchRegime(text: string): Regime | null {
  const t = text.toLowerCase();
  for (const r of REGIMES) if (t.includes(r.replace('-', ' ')) || t.includes(r)) return r;
  if (/\btrend/.test(t)) return 'trending';
  if (/\brange/.test(t)) return 'ranging';
  if (/\bvol/.test(t) && /\bhigh|elevated|expanded/.test(t)) return 'volatile';
  if (/\bvol/.test(t) && /\blow|compress|contract/.test(t)) return 'low-volatility';
  if (/\bbreak\s?out/.test(t)) return 'breakout';
  if (/\bmean\s?revert/.test(t)) return 'mean-reversion';
  if (/\baccumulat/.test(t)) return 'accumulation';
  if (/\bdistribut/.test(t)) return 'distribution';
  return null;
}
