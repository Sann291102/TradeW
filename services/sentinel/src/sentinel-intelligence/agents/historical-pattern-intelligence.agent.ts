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
import type { LiveBaseRate } from './agent.contract';
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
 * Two independent memories, in strict precedence:
 *
 *  1. **The measured live record** — the Brain's outcome-tagged occurrences of
 *     this exact pattern, pre-resolved into `context.baseRates` by the engine.
 *     This is what actually happened to this setup in this live market.
 *  2. **Self-similarity** — comparable shapes in the candle history already in
 *     the shared snapshot, and what followed them.
 *
 * The live record wins where the two disagree, and the disagreement is REPORTED
 * rather than averaged away: a shape that rhymes with the chart's own past but
 * has repeatedly failed live is a materially different situation from one with
 * no live record at all, and a reader has to be able to tell them apart.
 *
 * This agent used to read `snapshot.candles` and nothing else, on the reasoning
 * that the Brain's base rates need Postgres and an accumulated history, and an
 * agent that abstained whenever infrastructure was cold would abstain on every
 * developer machine and in CI. That reasoning still holds and is still honoured
 * — self-similarity remains the floor, and a cold or empty base-rate map
 * changes nothing about it. What it did NOT justify was ignoring the live
 * record when it exists: the agent whose whole remit is "what happened last
 * time" was the one agent with no memory, while the measured answer sat in
 * Postgres and was read later in the same run, at the gate.
 *
 * The zero-I/O property is unchanged. `context.baseRates` is resolved once by
 * the engine and handed over, exactly like `snapshot`; this agent performs no
 * lookup and holds no dependency on the Brain.
 */
@Injectable()
export class HistoricalPatternIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'historical-pattern-intelligence';
  readonly remit = 'Whether comparable structure has occurred before in the available history, and what followed it.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const candles = context.snapshot?.candles ?? [];
    const live = strongestLiveRecord(context);

    // A precedent search needs enough history to contain precedents. The
    // arithmetic is explicit so the abstention message can state the shortfall.
    //
    // A live record is reported even when the candles are too thin for
    // self-similarity: "this setup has resolved 14 times live, 71% continuation"
    // is a complete answer to this agent's question and does not become
    // unavailable because the snapshot is short. Abstaining with a measured
    // base rate in hand would be withholding the better of the two memories.
    const required = WINDOW + HORIZON + MIN_SAMPLE;
    if (candles.length < required) {
      if (!live) {
        return builder
          .abstain(
            `Only ${candles.length} bars of history are available; at least ${required} are needed before a base rate means anything.`,
          )
          .build();
      }
      return this.fromLiveRecordAlone(builder, context, live, candles.length, required);
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
    let structural = edge * (outcome.sampleTooSmall ? sampleFactor * 0.5 : sampleFactor);

    let stance: 'bullish' | 'bearish' | 'neutral' =
      outcome.sampleTooSmall || edge < 0.2
        ? 'neutral'
        : outcome.bullishRate > 0.5
          ? 'bullish'
          : 'bearish';

    let headline = outcome.sampleTooSmall
      ? `Only ${outcome.matches} comparable episodes exist — too few to call a base rate.`
      : `Comparable structure resolved higher ${(outcome.bullishRate * 100).toFixed(0)}% of the time across ${outcome.matches} episodes.`;

    // ---- the measured live record ---------------------------------------
    if (live) {
      builder.measured(
        `${live.pattern.replace(/_/g, ' ')} has ${live.sample} outcome-tagged occurrence(s) in live-market memory: ${describeDistribution(live)}`,
        live.sample,
        live.reliable ? 0.95 : 0.5,
      );

      if (live.reliable) {
        const liveBullish = liveBullishRate(live);
        const liveEdge = Math.abs(liveBullish - 0.5) * 2;

        // The live record OUTRANKS self-similarity, it does not average with
        // it. Averaging would let a strong shape-match dilute a measured
        // failure rate, which is precisely backwards: the corpus and the chart
        // describe what the setup is supposed to do, and only the live record
        // says what it has actually done here.
        stance = liveEdge < 0.2 ? 'neutral' : liveBullish > 0.5 ? 'bullish' : 'bearish';
        structural = liveEdge * Math.min(1, live.sample / (MIN_SAMPLE * 2));
        headline =
          `Measured live: this setup resolved higher ${(liveBullish * 100).toFixed(0)}% of ` +
          `${live.sample} recorded occurrences, against ${(outcome.bullishRate * 100).toFixed(0)}% across ` +
          `${outcome.matches} comparable episodes on this chart.`;

        // A disagreement between the two memories is stated, never smoothed
        // over. It is the single most useful thing this agent can report: the
        // chart's own past and the setup's live record pointing opposite ways
        // is a warning that reading the shape is not enough here.
        const shapeStance = outcome.bullishRate > 0.5 ? 'bullish' : 'bearish';
        if (!outcome.sampleTooSmall && stance !== 'neutral' && shapeStance !== stance) {
          builder.derived(
            `The chart's own comparable episodes lean ${shapeStance} while the measured live record leans ${stance} — ` +
              'the live record is the one that has actually resolved, so it is the one reported',
            liveBullish,
            0.85,
          );
          // A contested read is a weaker read even when the better source wins.
          structural *= 0.8;
        }
      } else {
        // Present but thin. Stated, and allowed to hold a directional read
        // back, but never to create one — a handful of live occurrences is not
        // a base rate and must not be dressed up as one.
        builder.derived(
          `Live sample is below the ${MIN_SAMPLE}-occurrence floor, so the measured record cannot yet override the chart's own precedents`,
          live.sample,
          0.5,
        );
        structural *= 0.85;
      }
    } else {
      builder.derived(
        'No outcome-tagged occurrences of this setup exist in live-market memory yet — this read rests on chart precedent alone',
        0,
        0.6,
      );
      // Chart precedent with no live confirmation is the weaker of the two
      // memories and is scored as such, rather than reading identically to a
      // measured result.
      structural *= 0.85;
    }

    return builder
      .quality(Math.min(1, candles.length / 200))
      .conclude(stance, blendConfidence(structural, groundingScore(citations)), headline)
      .build();
  }

  /**
   * A verdict from the live record when the snapshot is too short for
   * self-similarity.
   *
   * Deliberately capped below what a full run can reach, and never directional
   * on a thin sample: this path has one memory rather than two, and a verdict
   * built from one source must not read as strongly as a corroborated one.
   */
  private fromLiveRecordAlone(
    builder: VerdictBuilder,
    context: AgentContext,
    live: LiveBaseRate,
    bars: number,
    required: number,
  ): AgentVerdict {
    builder.measured(
      `Only ${bars} bars available (${required} needed for a precedent search), so this rests entirely on the live record`,
      bars,
      0.4,
    );
    builder.measured(
      `${live.pattern.replace(/_/g, ' ')} has ${live.sample} outcome-tagged occurrence(s) in live-market memory: ${describeDistribution(live)}`,
      live.sample,
      live.reliable ? 0.9 : 0.5,
    );

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

    if (!live.reliable) {
      return builder
        .quality(0.4)
        .conclude(
          'neutral',
          0.15,
          `${live.sample} live occurrence(s) recorded and too little chart history to look for precedents — nothing here is a base rate yet.`,
        )
        .build();
    }

    const bullish = liveBullishRate(live);
    const edge = Math.abs(bullish - 0.5) * 2;
    const structural = edge * Math.min(1, live.sample / (MIN_SAMPLE * 2)) * 0.75;

    return builder
      .quality(0.6)
      .conclude(
        edge < 0.2 ? 'neutral' : bullish > 0.5 ? 'bullish' : 'bearish',
        blendConfidence(structural, groundingScore(citations)),
        `Measured live: this setup resolved higher ${(bullish * 100).toFixed(0)}% of ` +
          `${live.sample} recorded occurrences. Chart history is too short to corroborate independently.`,
      )
      .build();
  }
}

/**
 * The live record this run should be judged against.
 *
 * A run can carry several validated detections and therefore several base
 * rates. The one with the largest sample is chosen because sample size is the
 * only thing that makes a base rate mean anything — picking the most flattering
 * rate, or averaging across patterns that are not the same pattern, would both
 * manufacture precision the data does not have.
 *
 * Returns null when the map is empty, which is the state on a cold database, in
 * CI, and on any run whose detections have never been recorded. Every caller
 * treats null as "no live record", never as a neutral or supporting result.
 */
export function strongestLiveRecord(context: AgentContext): LiveBaseRate | null {
  let best: LiveBaseRate | null = null;
  for (const rate of context.baseRates.values()) {
    if (rate.sample === 0) continue;
    if (!best || rate.sample > best.sample) best = rate;
  }
  return best;
}

/**
 * Share of recorded occurrences that resolved HIGHER.
 *
 * Directly comparable with `SimilarityOutcome.bullishRate`, which is the whole
 * point: the two memories have to be measured the same way before either can
 * be said to agree or disagree with the other.
 *
 * The vocabulary is fixed by `OutcomeLearningService.evaluatePending`, which
 * writes exactly three values and keys them to ABSOLUTE direction, not to the
 * setup's own bias:
 *
 *   `continued_up`   — price rose more than MOVE_THRESHOLD_PCT
 *   `continued_down` — price fell more than MOVE_THRESHOLD_PCT
 *   `unclear`        — the move stayed inside the threshold
 *
 * Read literally, so a rename in that writer shows up here as an obviously
 * wrong 0% rather than as a plausible-looking number. `unclear` counts in the
 * denominator: dropping it would let two decisive episodes out of twenty read
 * as a 100% base rate, when the honest reading is that this setup mostly does
 * nothing.
 *
 * Note the scope this inherits from the Brain: occurrences are pooled ACROSS
 * SYMBOLS for a pattern name. That is the Brain's existing, deliberate
 * definition of a base rate ("across N past occurrences of this pattern"), and
 * the evidence line this feeds says "in live-market memory" rather than naming
 * the symbol, so the verdict does not overclaim.
 */
export function liveBullishRate(rate: LiveBaseRate): number {
  const total = Object.values(rate.distribution).reduce((a, b) => a + b, 0);
  if (total === 0) return 0.5;
  return (rate.distribution.continued_up ?? 0) / total;
}

/** The outcome distribution as a short, readable phrase. */
export function describeDistribution(rate: LiveBaseRate): string {
  const total = Object.values(rate.distribution).reduce((a, b) => a + b, 0);
  if (total === 0) return 'no resolved outcomes yet';
  return Object.entries(rate.distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, count]) => `${outcome.replace(/_/g, ' ')} ${Math.round((count / total) * 100)}%`)
    .join(', ');
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
