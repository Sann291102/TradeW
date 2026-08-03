import { Injectable } from '@nestjs/common';
import type { Candle } from '@tradew/types';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  blendConfidence,
  gatherCitations,
  gatherConcepts,
  groundingScore,
} from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/** Minimum comparable episodes before a base rate is reported as a base rate. */
const MIN_SAMPLE = 8;
/** Bars of shape compared when looking for a precedent. */
const WINDOW = 8;
/** Bars forward the outcome is measured over. */
const HORIZON = 6;

export interface SimilarityOutcome {
  matches: number;
  /** Share of matches whose forward move was positive. */
  bullishRate: number;
  /** Mean forward move, in percent. */
  meanForwardPct: number;
  /** Median absolute forward move — the typical magnitude, outlier-resistant. */
  medianAbsMovePct: number;
  /** True when fewer than MIN_SAMPLE precedents were found. */
  sampleTooSmall: boolean;
}

/**
 * Historical Pattern Intelligence — has this shape happened before, and what
 * followed?
 *
 * Computed from the candle history already in the shared snapshot rather than
 * from the Brain's Postgres pattern tables. That choice is deliberate: the
 * Brain's base rates need Postgres, pgvector and an accumulated observation
 * history, and an agent that abstains whenever infrastructure is cold would
 * abstain on every developer machine and in CI. Self-similarity over the bars
 * in hand is weaker evidence, but it is *honest, reproducible* evidence and it
 * is always available — and the sample-size gate below makes sure it is never
 * dressed up as more than it is.
 */
@Injectable()
export class HistoricalPatternIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'historical-pattern-intelligence';
  readonly remit = 'Whether comparable structure has occurred before in the available history, and what followed it.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const candles = context.snapshot?.candles ?? [];

    // A precedent search needs enough history to contain precedents. The
    // arithmetic is explicit so the abstention message can state the shortfall.
    const required = WINDOW + HORIZON + MIN_SAMPLE;
    if (candles.length < required) {
      return builder
        .abstain(
          `Only ${candles.length} bars of history are available; at least ${required} are needed before a base rate means anything.`,
        )
        .build();
    }

    const outcome = findSimilarEpisodes(candles, WINDOW, HORIZON);

    if (outcome.matches === 0) {
      return builder
        .quality(0.7)
        .conclude(
          'neutral',
          0.15,
          'No comparable structure appears in the available history — this shape has no precedent to measure against.',
        )
        .build();
    }

    builder.measured(
      `${outcome.matches} comparable episode${outcome.matches === 1 ? '' : 's'} found in the available history`,
      outcome.matches,
      0.7,
    );
    builder.derived(
      `${(outcome.bullishRate * 100).toFixed(0)}% of those resolved higher over the following ${HORIZON} bars`,
      outcome.bullishRate,
      outcome.sampleTooSmall ? 0.3 : 0.8,
    );
    builder.derived(
      `Typical move after the pattern was ${outcome.medianAbsMovePct.toFixed(2)}% (mean ${outcome.meanForwardPct >= 0 ? '+' : ''}${outcome.meanForwardPct.toFixed(2)}%)`,
      outcome.meanForwardPct,
      0.5,
    );

    if (outcome.sampleTooSmall) {
      // Stated as evidence, not buried in a confidence number, because the
      // reader needs to know the base rate is thin even if they ignore the
      // score entirely.
      builder.derived(
        `Sample is below the ${MIN_SAMPLE}-episode threshold, so this is a weak precedent rather than a base rate`,
        outcome.matches,
        0.6,
      );
    }

    const citations = gatherCitations(context, ['base rate sample size pattern reliability backtest'], {
      preferKinds: ['book'],
    });
    if (citations.length > 0) {
      builder.knowledge(
        'The literature is explicit that a pattern edge only means something once the sample is large enough to distinguish it from noise.',
        citations,
        0.5,
      );
    }
    builder.supporting(gatherConcepts(context, 'historical base rate pattern reliability'));

    // Confidence keyed to how far the base rate departs from a coin flip, then
    // scaled down hard for a thin sample. A 100% bullish rate over 3 episodes
    // must not outrank a 65% rate over 40.
    const edge = Math.abs(outcome.bullishRate - 0.5) * 2;
    const sampleFactor = Math.min(1, outcome.matches / (MIN_SAMPLE * 2));
    const structural = edge * (outcome.sampleTooSmall ? sampleFactor * 0.5 : sampleFactor);

    const stance =
      outcome.sampleTooSmall || edge < 0.2
        ? 'neutral'
        : outcome.bullishRate > 0.5
          ? 'bullish'
          : 'bearish';

    return builder
      .quality(Math.min(1, candles.length / 200))
      .conclude(
        stance,
        blendConfidence(structural, groundingScore(citations)),
        outcome.sampleTooSmall
          ? `Only ${outcome.matches} comparable episodes exist — too few to call a base rate.`
          : `Comparable structure resolved higher ${(outcome.bullishRate * 100).toFixed(0)}% of the time across ${outcome.matches} episodes.`,
      )
      .build();
  }
}

/**
 * Find past windows whose normalised shape resembles the most recent one, and
 * measure what happened next.
 *
 * Shape is compared on percentage returns rather than prices so an episode at
 * 18 000 is comparable with one at 24 000 — the same structure at a different
 * absolute level is the same structure. Candidate windows are stepped by one
 * bar but excluded if they overlap the window being matched, since a window
 * trivially resembles itself shifted by one bar and would flood the sample
 * with near-duplicates of the present.
 */
export function findSimilarEpisodes(candles: Candle[], window: number, horizon: number): SimilarityOutcome {
  const closes = candles.map((c) => c.close);
  const target = shapeOf(closes.slice(-window));
  if (target === null) {
    return { matches: 0, bullishRate: 0, meanForwardPct: 0, medianAbsMovePct: 0, sampleTooSmall: true };
  }

  const forwardMoves: number[] = [];
  // Stop `window + horizon` short of the end so every candidate has a full
  // forward window that does not run into the bars being matched.
  const lastCandidate = closes.length - window - horizon - window;

  for (let start = 0; start <= lastCandidate; start++) {
    const candidate = shapeOf(closes.slice(start, start + window));
    if (candidate === null) continue;
    if (distance(target, candidate) > SIMILARITY_TOLERANCE) continue;

    const entry = closes[start + window - 1];
    const exit = closes[start + window - 1 + horizon];
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) continue;
    forwardMoves.push(((exit - entry) / entry) * 100);
  }

  if (forwardMoves.length === 0) {
    return { matches: 0, bullishRate: 0, meanForwardPct: 0, medianAbsMovePct: 0, sampleTooSmall: true };
  }

  const bullish = forwardMoves.filter((m) => m > 0).length;
  const mean = forwardMoves.reduce((s, m) => s + m, 0) / forwardMoves.length;
  const absSorted = forwardMoves.map(Math.abs).sort((a, b) => a - b);
  const median = absSorted[Math.floor(absSorted.length / 2)];

  return {
    matches: forwardMoves.length,
    bullishRate: bullish / forwardMoves.length,
    meanForwardPct: mean,
    medianAbsMovePct: median,
    sampleTooSmall: forwardMoves.length < MIN_SAMPLE,
  };
}

/**
 * Mean absolute per-bar deviation below which two shapes count as comparable.
 *
 * Tuned so genuinely similar structures match without the tolerance being so
 * wide that every window matches every other — at which point the "base rate"
 * degenerates into the instrument's unconditional drift.
 */
const SIMILARITY_TOLERANCE = 0.45;

/** Normalise a price window to a comparable shape: z-scored bar-to-bar returns. */
export function shapeOf(closes: number[]): number[] | null {
  if (closes.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) return null;
    returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  // A perfectly flat window has no shape to compare — treat it as unmatched
  // rather than dividing by zero and producing NaNs downstream.
  if (sd < 1e-9) return null;
  return returns.map((r) => (r - mean) / sd);
}

/** Mean absolute deviation between two equal-length shapes. */
export function distance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}
