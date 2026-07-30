import { Inject, Injectable } from '@nestjs/common';
import { MemoryRecord, MemorySearchHit } from '@tradew/ai-core';
import { REASONING_CONFIG, ReasoningConfig } from './reasoning.config';
import { RankBreakdown, RankedKnowledge, RankingHints } from './types';

/**
 * Multi-factor ranking layer applied on top of raw semantic similarity.
 *
 * The retriever alone answers "how close to the query is this memory?"; a
 * runtime reasoning system needs six more inputs — how trustworthy the
 * record's authors said it was, how fresh it is, how mature the concept it
 * carries is, how load-bearing that concept is elsewhere in the system,
 * and whether it belongs to the current user. This service is the *only*
 * place those factor definitions live, so a change to the weighting is one
 * config edit rather than a scattered rewrite.
 *
 * Every factor is clamped to [0, 1] and each `RankedKnowledge` returned
 * exposes the breakdown, so an explanation can cite exactly why a record
 * ranked where it did — no black-box ordering.
 */
@Injectable()
export class KnowledgeRankingService {
  constructor(@Inject(REASONING_CONFIG) private readonly config: ReasoningConfig) {}

  rank(hits: MemorySearchHit[], hints: RankingHints = {}, at: Date = new Date()): RankedKnowledge[] {
    const requireTags = hints.requireTags ?? [];
    const boostTags = hints.boostTags ?? [];
    const preferConceptIds = hints.preferConceptIds ?? [];
    const userId = hints.userId ?? null;
    const now = at.getTime();

    return hits
      .filter((h) => this.passesRequire(h.record, requireTags))
      .map((h) => this.rankOne(h, boostTags, preferConceptIds, userId, now))
      .sort((a, b) => b.score - a.score);
  }

  /** Rank a single hit — exposed for services that already have a partial score. */
  rankOne(
    hit: MemorySearchHit,
    boostTags: string[],
    preferConceptIds: string[],
    userId: string | null,
    nowMs: number,
  ): RankedKnowledge {
    const record = hit.record;
    const breakdown: RankBreakdown = {
      similarity: clamp01(hit.score),
      confidence: clamp01(record.confidence),
      freshness: this.freshness(record, nowMs),
      maturity: this.maturity(record),
      importance: this.importance(record, boostTags, preferConceptIds),
      userRelevance: userId && record.userId === userId ? 1 : 0.5,
    };
    const w = this.config.weights;
    const score =
      breakdown.similarity * w.similarity +
      breakdown.confidence * w.confidence +
      breakdown.freshness * w.freshness +
      breakdown.maturity * w.maturity +
      breakdown.importance * w.importance +
      breakdown.userRelevance * w.userRelevance;
    return { hit, score: Number(clamp01(score).toFixed(4)), breakdown };
  }

  private passesRequire(record: MemoryRecord, requireTags: string[]): boolean {
    if (requireTags.length === 0) return true;
    for (const tag of requireTags) {
      if (!record.tags.includes(tag)) return false;
    }
    return true;
  }

  /**
   * Exponential decay by half-life, with `staleAfter` treated as a hard
   * decay to zero at expiry. The default half-life (7 days) makes month-old
   * research score ~0.05 without ever dropping to zero — knowledge doesn't
   * become false with age, but it does become less relevant.
   */
  private freshness(record: MemoryRecord, nowMs: number): number {
    if (record.staleAfter) {
      const remaining = record.staleAfter.getTime() - nowMs;
      if (remaining <= 0) return 0;
      const total = record.staleAfter.getTime() - record.createdAt.getTime();
      return total > 0 ? clamp01(remaining / total) : 1;
    }
    const ageMs = Math.max(0, nowMs - record.createdAt.getTime());
    const halfLife = this.config.freshnessHalfLifeMs;
    return clamp01(Math.pow(0.5, ageMs / halfLife));
  }

  /**
   * Concept-maturity signal derived from vault-authored tags:
   *   `maturity:established` → 1.0
   *   `maturity:emerging`    → 0.7
   *   `maturity:contested`   → 0.4
   * Records without a maturity tag default to 0.75 — neither penalised nor
   * boosted so that legacy pattern_occurrence memories retain their prior
   * behaviour.
   */
  private maturity(record: MemoryRecord): number {
    for (const tag of record.tags) {
      if (tag === 'maturity:established') return 1.0;
      if (tag === 'maturity:emerging') return 0.7;
      if (tag === 'maturity:contested') return 0.4;
    }
    return 0.75;
  }

  /**
   * Importance signal derived from what a record is *about*, not how similar
   * it is. Strategy/pattern knowledge is load-bearing (it shows up in every
   * confidence calc), so it ranks above general concept notes; glossary
   * ranks lowest because it's foundation, not signal.
   */
  private importance(record: MemoryRecord, boostTags: string[], preferConceptIds: string[]): number {
    let score = 0.5;
    const tagSet = new Set(record.tags);

    // Domain-based baseline.
    for (const tag of record.tags) {
      if (!tag.startsWith('domain:')) continue;
      const domain = tag.slice(7);
      if (domain === 'patterns' || domain === 'institutional-concepts') score = Math.max(score, 0.85);
      else if (domain === 'trading-psychology' || domain === 'risk-management') score = Math.max(score, 0.8);
      else if (domain === 'options' || domain === 'derivatives') score = Math.max(score, 0.75);
      else if (domain === 'glossary') score = Math.max(score, 0.35);
      else score = Math.max(score, 0.65);
    }

    if (tagSet.has('pattern_occurrence')) score = Math.max(score, 0.9);
    if (tagSet.has('source:book')) score = Math.max(score, 0.6);

    // Explicit caller boosts stack additively but cap at 1.
    let boost = 0;
    for (const t of boostTags) if (tagSet.has(t)) boost += 0.1;
    for (const t of record.tags) {
      if (t.startsWith('concept:') && preferConceptIds.includes(t.slice(8))) boost += 0.2;
    }

    return clamp01(score + boost);
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
