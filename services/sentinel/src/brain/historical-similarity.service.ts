import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemoryStore } from '@tradew/ai-core';
import { MEMORY_STORE } from './tokens';

export interface HistoricalSimilarityResult {
  patternName: string;
  symbol: string;
  occurrences: number;
  withKnownOutcome: number;
  outcomeCounts: Record<string, number>;
  /** below this many outcome-tagged samples, statistics are withheld as unreliable */
  sampleTooSmall: boolean;
}

const MIN_SAMPLE = 5;

/**
 * Historical Similarity Engine — "has this happened before, and what
 * usually followed?" Queries persisted pattern_occurrence memories
 * (Pattern Recognition Engine's output) for the same pattern+symbol.
 * Reports frequency, never a directional call — and explicitly withholds
 * a verdict when the sample is too small to mean anything.
 */
@Injectable()
export class HistoricalSimilarityService {
  private readonly logger = new Logger(HistoricalSimilarityService.name);

  constructor(@Inject(MEMORY_STORE) private readonly memory: MemoryStore) {}

  async similarPast(symbol: string, patternName: string, limit = 25): Promise<HistoricalSimilarityResult> {
    try {
      const hits = await this.memory.search({
        text: `${patternName.replace(/_/g, ' ')} on ${symbol}`,
        namespace: 'sentinel',
        tags: ['pattern_occurrence', patternName],
        limit,
      });
      // the tags filter above is OR-semantics (coarse recall) — metadata gives the exact match
      const relevant = hits.filter((h) => h.record.metadata?.symbol === symbol && h.record.metadata?.pattern === patternName);
      const withOutcome = relevant.filter((h) => h.record.metadata?.outcome);
      const outcomeCounts: Record<string, number> = {};
      for (const h of withOutcome) {
        const outcome = String(h.record.metadata!.outcome);
        outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
      }
      return {
        patternName,
        symbol,
        occurrences: relevant.length,
        withKnownOutcome: withOutcome.length,
        outcomeCounts,
        sampleTooSmall: withOutcome.length < MIN_SAMPLE,
      };
    } catch (err) {
      this.logger.warn(`historical similarity lookup failed for ${patternName}/${symbol}: ${err}`);
      return { patternName, symbol, occurrences: 0, withKnownOutcome: 0, outcomeCounts: {}, sampleTooSmall: true };
    }
  }

  /** Plain-language summary, honest about sample size — never a directional call. */
  describe(result: HistoricalSimilarityResult): string {
    if (result.occurrences === 0) return `No prior recorded occurrences of this pattern on ${result.symbol} yet — this is the first.`;
    if (result.sampleTooSmall) {
      return `${result.occurrences} prior occurrence(s) recorded on ${result.symbol}, but too few with a known outcome (${result.withKnownOutcome}) to report a reliable historical frequency yet.`;
    }
    const total = Object.values(result.outcomeCounts).reduce((a, b) => a + b, 0);
    const parts = Object.entries(result.outcomeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`);
    return `${result.occurrences} prior occurrences on ${result.symbol}, ${result.withKnownOutcome} with a known outcome: ${parts.join(', ')}. Historical frequency, not a prediction for this instance.`;
  }
}
