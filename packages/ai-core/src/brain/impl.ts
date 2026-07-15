import { MemoryRecord } from '../domain/knowledge';
import { KnowledgeGraph } from '../graph/interfaces';
import { MemoryStore } from '../memory/interfaces';
import { CORE_GUARDRAILS } from '../prompts/interfaces';
import { ProviderManager } from '../providers/provider-manager';
import { Retriever } from '../rag/interfaces';
import { ResearchEngine } from '../research/interfaces';
import { ContextManager } from '../context/interfaces';
import {
  BrainAskRequest,
  BrainAskResponse,
  LearnInput,
  LearningEngine,
  NeuralBrain,
} from './interfaces';

/**
 * Default Learning Engine: summarize (LLM, only when content is long) →
 * store to memory (embeds internally) → mirror entities into the knowledge
 * graph and link record relationships.
 */
export class DefaultLearningEngine implements LearningEngine {
  constructor(
    private memory: MemoryStore,
    private providers: ProviderManager,
    private graph?: KnowledgeGraph,
  ) {}

  async ingest(input: LearnInput): Promise<MemoryRecord[]> {
    const summary =
      input.content.length > 600 ? await this.summarize(input.content) : input.content.split('\n')[0].slice(0, 300);

    const record = await this.memory.store({
      summary,
      content: input.content,
      source: { kind: this.sourceKindFor(input.kind), reference: input.sourceReference },
      confidence: 0.6,
      tags: input.tags ?? [],
      entities: [],
      relatedIds: [],
      userId: input.userId ?? null,
      namespace: input.namespace ?? 'global',
    });

    // connect to the most similar existing memories so knowledge accumulates as a graph
    const similar = await this.memory.search({
      text: summary,
      userId: input.userId ?? null,
      namespace: input.namespace,
      limit: 3,
      minScore: 0.75,
    });
    for (const hit of similar) {
      if (hit.record.id !== record.id) await this.memory.connect(record.id, hit.record.id, 'related');
    }

    if (this.graph) {
      for (const entity of record.entities) {
        const node = await this.graph.upsertNode(entity);
        await this.graph.upsertEdge(node.id, node.id, 'self', 0).catch(() => undefined);
      }
    }

    return [record];
  }

  private sourceKindFor(kind: LearnInput['kind']) {
    const map = {
      task_completed: 'task_output',
      document_imported: 'document',
      research_result: 'research',
      conversation_turn: 'conversation',
      observation_recorded: 'observation',
      journal_entry: 'trading_journal',
      report_generated: 'market_report',
    } as const;
    return map[kind];
  }

  private async summarize(content: string): Promise<string> {
    const llm = this.providers.getLlm();
    const response = await llm.complete({
      tier: 'fast',
      maxTokens: 150,
      messages: [
        { role: 'system', content: 'Summarize into 1-2 dense sentences. Facts only, no advice.' },
        { role: 'user', content: content.slice(0, 6000) },
      ],
    });
    return response.text.trim();
  }
}

/**
 * Default Neural Brain — the locked pipeline:
 *   search memory → if sufficient, answer from it
 *                 → if missing: research → learn → store → connect → answer
 * Every ask() also feeds the Q&A back into memory (event-driven learning).
 */
export class DefaultNeuralBrain implements NeuralBrain {
  /** below this top-hit similarity, memory is considered insufficient */
  private static readonly SUFFICIENT_SCORE = 0.55;

  constructor(
    private deps: {
      providers: ProviderManager;
      retriever: Retriever;
      research: ResearchEngine;
      learning: LearningEngine;
      context: ContextManager;
      /** extra system prompt prepended for the answering completion */
      systemPrompt?: string;
    },
  ) {}

  async ask(request: BrainAskRequest): Promise<BrainAskResponse> {
    let retrieval = await this.deps.retriever.retrieve({
      query: request.question,
      userId: request.userId,
      namespace: request.namespace,
    });

    const learned: MemoryRecord[] = [];
    const memorySufficient =
      retrieval.hits.length > 0 && retrieval.hits[0].score >= DefaultNeuralBrain.SUFFICIENT_SCORE;

    let path: BrainAskResponse['path'] = memorySufficient ? 'memory' : 'model_only';
    if (!memorySufficient && request.allowResearch) {
      const run = await this.deps.research.run({
        query: request.question,
        userId: request.userId,
        namespace: request.namespace,
        learn: true,
      });
      learned.push(...run.learned);
      // re-retrieve so the fresh knowledge participates in ranked context
      retrieval = await this.deps.retriever.retrieve({
        query: request.question,
        userId: request.userId,
        namespace: request.namespace,
      });
      path = retrieval.hits.length > 0 ? (memorySufficient ? 'memory+research' : 'research') : 'model_only';
    }

    const assembled = this.deps.context.assemble({
      systemPrompt:
        this.deps.systemPrompt ??
        'You are the TradeW Neural Brain — a market intelligence and education engine. Answer from the provided knowledge when available and say when knowledge is missing or stale.',
      guardrails: [...CORE_GUARDRAILS],
      retrieval,
      inlineContext: request.inlineContext,
      userMessage: request.question,
      budget: { maxInputTokens: 8000, reservedOutputTokens: 1000 },
    });

    const llm = this.deps.providers.getLlm();
    const completion = await llm.complete({
      messages: assembled.messages,
      tier: request.tier ?? 'balanced',
      maxTokens: 1000,
    });

    // the interaction itself becomes memory (kind: conversation_turn)
    const turn = await this.deps.learning.ingest({
      kind: 'conversation_turn',
      content: `Q: ${request.question}\nA: ${completion.text}`,
      userId: request.userId,
      namespace: request.namespace,
      tags: ['conversation'],
    });
    learned.push(...turn);

    return {
      answer: completion.text,
      path,
      retrieval,
      learned,
      confidence: retrieval.hits[0]?.score ?? (path === 'research' ? 0.5 : 0.3),
    };
  }

  async learn(input: LearnInput): Promise<MemoryRecord[]> {
    return this.deps.learning.ingest(input);
  }
}
