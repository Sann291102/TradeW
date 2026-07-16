import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemoryStore } from '@tradew/ai-core';
import { Signal } from '../domain';
import { ConceptLearningEngine } from './concept-learning.service';
import { MEMORY_STORE } from './tokens';

/**
 * Pattern Recognition Engine — every triggered trap/technical signal becomes
 * a durable, queryable `pattern_occurrence`: not just logged for the current
 * response, but written into the Brain so Historical Similarity and Strategy
 * Intelligence can query it later. Untriggered signals are not recorded —
 * only what actually happened is knowledge.
 */
@Injectable()
export class PatternRecognitionService {
  private readonly logger = new Logger(PatternRecognitionService.name);

  constructor(
    private readonly concepts: ConceptLearningEngine,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
  ) {}

  async recordOccurrence(symbol: string, signal: Signal, lastPrice: number): Promise<void> {
    if (!signal.triggered) return;
    try {
      const records = await this.concepts.ingest(
        {
          kind: 'observation_recorded',
          content: `${signal.name.replace(/_/g, ' ')} detected on ${symbol}: ${signal.evidence.join('; ')}`,
          namespace: 'sentinel',
          tags: ['pattern_occurrence', signal.name],
          sourceReference: symbol,
        },
        { symbols: [symbol], patterns: [signal.name] },
      );
      for (const record of records) {
        await this.memory.update(record.id, {
          metadata: {
            pattern: signal.name,
            symbol,
            priceAtDetection: lastPrice,
            detectedAt: new Date().toISOString(),
            outcome: null,
          },
        });
      }
    } catch (err) {
      // Pattern recognition is additive intelligence — it must never break
      // the core observation flow it's built on top of.
      this.logger.warn(`could not persist pattern occurrence ${signal.name}/${symbol}: ${err}`);
    }
  }
}
