import { Inject, Injectable } from '@nestjs/common';
import { EntityRef, KnowledgeGraph, LearnInput, LearningEngine, MemoryRecord, MemoryStore } from '@tradew/ai-core';
import { BASE_LEARNING_ENGINE, KNOWLEDGE_GRAPH, MEMORY_STORE } from './tokens';

const SECTOR_KEYWORDS = ['BANKING', 'IT', 'PHARMA', 'AUTO', 'ENERGY', 'FMCG', 'METALS', 'REALTY', 'INFRA', 'PSU'];
const STOPWORDS = new Set(['THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAS', 'WAS', 'ITS', 'OTHER']);

export interface ExtractionHints {
  symbols?: string[];
  patterns?: string[];
  sectors?: string[];
}

/**
 * Concept Learning Engine — turns raw text into linked knowledge instead of
 * an inert blob. Every ingestion extracts entities (symbols, detected
 * patterns, sectors) and:
 *   1. writes them onto the MemoryRecord (so future search/filter by entity works)
 *   2. upserts each as a KnowledgeGraph node
 *   3. links them to each other and to the memory record's own node
 *
 * Hints from callers who already know the entity (e.g. Pattern Recognition
 * already knows the symbol and pattern name) take priority over generic
 * regex extraction, which exists as a fallback for free-text ingestion
 * (research results, Q&A) where nothing is known in advance.
 */
@Injectable()
export class ConceptLearningEngine implements LearningEngine {
  constructor(
    @Inject(BASE_LEARNING_ENGINE) private readonly base: LearningEngine,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
    @Inject(KNOWLEDGE_GRAPH) private readonly graph: KnowledgeGraph,
  ) {}

  async ingest(input: LearnInput, hints: ExtractionHints = {}): Promise<MemoryRecord[]> {
    const records = await this.base.ingest(input);
    const entities = this.extract(input.content, hints);
    if (entities.length === 0) return records;

    for (const record of records) {
      await this.memory.update(record.id, { entities });

      const recordNode = await this.graph.upsertNode(
        { type: 'memory', id: record.id, label: record.summary.slice(0, 80) },
        { namespace: input.namespace ?? 'global', sourceKind: this.base ? input.kind : undefined },
      );
      const entityNodes = await Promise.all(entities.map((e) => this.graph.upsertNode(e)));
      for (const node of entityNodes) {
        await this.graph.upsertEdge(recordNode.id, node.id, 'mentions');
      }
      // link co-occurring entities to each other (symbol <-> pattern <-> sector)
      for (let i = 0; i < entityNodes.length; i++) {
        for (let j = i + 1; j < entityNodes.length; j++) {
          await this.graph.upsertEdge(entityNodes[i].id, entityNodes[j].id, 'co_occurs_with', 1);
        }
      }
    }
    return records;
  }

  /** Extraction only, no ingestion — used when a caller wants entities without writing new memory. */
  extract(text: string, hints: ExtractionHints = {}): EntityRef[] {
    const out: EntityRef[] = [];
    const seen = new Set<string>();
    const add = (type: string, id: string, label?: string) => {
      const key = `${type}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ type, id: `${type}:${id}`, label: label ?? id });
    };

    for (const s of hints.symbols ?? []) add('symbol', s);
    for (const p of hints.patterns ?? []) add('pattern', p, p.replace(/_/g, ' '));
    for (const s of hints.sectors ?? []) add('sector', s);

    // fallback regex extraction for free text without hints
    if (!hints.symbols) {
      const tokens = text.match(/\b[A-Z]{2,10}\b/g) ?? [];
      for (const t of tokens) {
        if (STOPWORDS.has(t) || SECTOR_KEYWORDS.includes(t)) continue;
        add('symbol', t);
      }
    }
    for (const sector of SECTOR_KEYWORDS) {
      if (new RegExp(`\\b${sector}\\b`, 'i').test(text)) add('sector', sector, sector);
    }

    return out;
  }
}
