import { MemorySearchHit, MemoryStore } from '../memory/interfaces';
import { Chunk, Chunker, RetrievalRequest, RetrievalResult, Retriever } from './interfaces';

/** Paragraph-preserving chunker with token-approximate limits (~4 chars/token). */
export class SimpleChunker implements Chunker {
  chunk(text: string, options?: { maxTokens?: number; overlapTokens?: number }): Chunk[] {
    const maxChars = (options?.maxTokens ?? 400) * 4;
    const overlapChars = (options?.overlapTokens ?? 40) * 4;
    const paragraphs = text.split(/\n{2,}/);
    const chunks: Chunk[] = [];
    let current = '';
    const push = () => {
      if (current.trim()) chunks.push({ text: current.trim(), index: chunks.length });
    };
    for (const p of paragraphs) {
      if (current.length + p.length + 2 > maxChars && current) {
        push();
        current = current.slice(-overlapChars);
      }
      current += (current ? '\n\n' : '') + p;
      // hard-split single paragraphs that alone exceed the limit
      while (current.length > maxChars) {
        const head = current.slice(0, maxChars);
        chunks.push({ text: head.trim(), index: chunks.length });
        current = current.slice(maxChars - overlapChars);
      }
    }
    push();
    return chunks;
  }
}

/**
 * Default retriever: semantic memory search + one-hop expansion through each
 * hit's related records, assembled into a ranked, token-budgeted context block.
 */
export class DefaultRetriever implements Retriever {
  constructor(
    private memory: MemoryStore,
    private options: { contextTokenBudget?: number } = {},
  ) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const hits = await this.memory.search({
      text: request.query,
      userId: request.userId,
      namespace: request.namespace,
      limit: request.limit ?? 6,
    });

    const graphHits: MemorySearchHit[] = [];
    if (request.graphExpansion !== false) {
      const seen = new Set(hits.map((h) => h.record.id));
      for (const hit of hits.slice(0, 3)) {
        for (const relatedId of hit.record.relatedIds.slice(0, 3)) {
          if (seen.has(relatedId)) continue;
          seen.add(relatedId);
          const related = await this.memory.get(relatedId);
          if (related) graphHits.push({ record: related, score: hit.score * 0.8 });
        }
      }
    }

    const budgetChars = (this.options.contextTokenBudget ?? 1500) * 4;
    let contextText = '';
    for (const h of [...hits, ...graphHits].sort((a, b) => b.score - a.score)) {
      const entry = `- [${h.record.source.kind}${h.record.staleAfter ? ', time-sensitive' : ''}, confidence ${h.record.confidence.toFixed(2)}] ${h.record.summary}\n`;
      if (contextText.length + entry.length > budgetChars) break;
      contextText += entry;
    }

    return { hits, graphHits, contextText: contextText.trim() };
  }
}
