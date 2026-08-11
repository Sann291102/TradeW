import { MemoryStore } from '../memory/interfaces';
import { CognitiveNetwork } from './network';
import { NewPercept } from './percept';

/**
 * LangChain interoperability — by structure, not by dependency.
 *
 * WHY THERE IS NO `import { BaseRetriever } from '@langchain/core'` HERE
 *
 * The requirement was that LangChain chains can read this brain. The
 * requirement was *not* that TradeW take on LangChain's abstraction stack, and
 * the difference matters because `@tradew/ai-core` already owns the same
 * concerns LangChain would bring: providers, embeddings, memory, retrieval,
 * tools, and an agent runtime (ARCHITECTURE Rule 2 — products depend on ai-core
 * and only ai-core for intelligence primitives). Importing LangChain into this
 * package would mean two provider wrappers, two memory contracts and two
 * telemetry paths, with `instrumentLlmProvider` — the chokepoint that makes the
 * admin console's cost figures complete — bypassed by every LangChain call.
 *
 * LangChain's core interfaces are structural. A retriever is anything with
 * `getRelevantDocuments`; a memory is anything with `loadMemoryVariables` and
 * `saveContext`; a document is `{ pageContent, metadata }`. TypeScript is
 * structurally typed, so implementing those shapes here means these objects can
 * be handed to a LangChain chain **and type-check against it**, with no import,
 * no version coupling, and nothing to keep in sync when LangChain's release
 * cadence moves.
 *
 * If a future consumer wants the full class hierarchy — callbacks, tracing,
 * `RunnableSequence` composition — the honest path is a separate
 * `@tradew/langchain` package that depends on both, so LangChain's weight lands
 * on the one service that asked for it rather than on every service that
 * imports ai-core. That is the seam this file is designed to leave open.
 */

/** LangChain's `Document`, structurally. */
export interface LcDocument {
  pageContent: string;
  metadata: Record<string, unknown>;
}

/** The subset of LangChain's `BaseRetriever` that chains actually invoke. */
export interface LcRetrieverLike {
  getRelevantDocuments(query: string): Promise<LcDocument[]>;
  /** LCEL entry point. Same call, newer name — both are provided so the object
   *  works with chains written against either generation of the API. */
  invoke(query: string): Promise<LcDocument[]>;
  lc_namespace: string[];
}

/** The subset of LangChain's `BaseMemory` that chains actually invoke. */
export interface LcMemoryLike {
  memoryKeys: string[];
  loadMemoryVariables(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  saveContext(inputs: Record<string, unknown>, outputs: Record<string, unknown>): Promise<void>;
}

export interface RetrieverOptions {
  /** Memory namespace to search. Defaults to everything. */
  namespace?: string;
  limit?: number;
  /** Drop hits below this similarity. */
  minScore?: number;
  userId?: string | null;
}

/**
 * Expose the memory store as a LangChain retriever.
 *
 * Retrieval goes through `MemoryStore.search`, so a LangChain chain gets the
 * same ranking, the same staleness handling and the same namespace isolation as
 * a native TradeW agent. A second retrieval path with its own scoring would
 * mean two answers to "what does the system know about X", and the one nobody
 * is watching would be the one that drifts.
 */
export function asLangChainRetriever(memory: MemoryStore, options: RetrieverOptions = {}): LcRetrieverLike {
  const search = async (query: string): Promise<LcDocument[]> => {
    const hits = await memory.search({
      text: query,
      namespace: options.namespace,
      userId: options.userId,
      limit: options.limit ?? 8,
      minScore: options.minScore,
    });
    return hits.map((hit) => ({
      pageContent: hit.record.content,
      // Provenance travels with the text. A chain that drops it produces an
      // unattributable answer, and this platform's guardrails assume every
      // claim can be traced to where it came from.
      metadata: {
        id: hit.record.id,
        score: hit.score,
        summary: hit.record.summary,
        confidence: hit.record.confidence,
        namespace: hit.record.namespace,
        tags: hit.record.tags,
        source: hit.record.source,
        createdAt: hit.record.createdAt.toISOString(),
      },
    }));
  };

  return {
    lc_namespace: ['tradew', 'cognition', 'retriever'],
    getRelevantDocuments: search,
    invoke: search,
  };
}

export interface ConversationMemoryOptions {
  /** Which key the chain reads the recalled context from. */
  memoryKey?: string;
  /** Which input key holds the user's turn. */
  inputKey?: string;
  /** Which output key holds the model's turn. */
  outputKey?: string;
  namespace?: string;
  userId?: string | null;
  limit?: number;
  /** Perceptor id attributed to turns written back in. */
  perceptorId?: string;
}

/**
 * Expose the cognitive network as LangChain conversation memory.
 *
 * This is the piece that answers "agents remember and get better while they
 * work". `loadMemoryVariables` retrieves what the network already knows about
 * the current turn; `saveContext` feeds the completed turn *back in as a
 * percept*, so it flows L1→L4 like any other observation and is subject to the
 * same salience gate and the same corroboration bar.
 *
 * Turns are **not** written straight to memory, which is the obvious shortcut
 * and the wrong one. Every conversational exchange becoming permanent knowledge
 * is how a memory store fills with restatements of itself inside a week, and
 * retrieval quality collapses long before anyone notices the row count. Routing
 * through the network means a turn is remembered when it corroborates something
 * or carries a genuinely novel signal, and is otherwise counted and dropped.
 */
export function asLangChainMemory(
  network: CognitiveNetwork,
  memory: MemoryStore,
  options: ConversationMemoryOptions = {},
): LcMemoryLike {
  const memoryKey = options.memoryKey ?? 'history';
  const inputKey = options.inputKey ?? 'input';
  const outputKey = options.outputKey ?? 'output';

  return {
    memoryKeys: [memoryKey],

    async loadMemoryVariables(values) {
      const query = String(values[inputKey] ?? '').trim();
      if (!query) return { [memoryKey]: '' };

      const hits = await memory.search({
        text: query,
        namespace: options.namespace,
        userId: options.userId,
        limit: options.limit ?? 6,
      });

      // Rendered as text rather than as objects: `memoryKey` is interpolated
      // into a prompt template, and a chain that stringifies an array of records
      // produces `[object Object]` in the model's context. Confidence is
      // included inline so the model can weigh a 0.4 recollection differently
      // from a 0.9 one instead of treating all recall as fact.
      const rendered = hits
        .map((hit) => `- (${hit.record.confidence.toFixed(2)}) ${hit.record.summary}`)
        .join('\n');

      return { [memoryKey]: rendered };
    },

    async saveContext(inputs, outputs) {
      const question = String(inputs[inputKey] ?? '').trim();
      const answer = String(outputs[outputKey] ?? '').trim();
      if (!question && !answer) return;

      const percept: NewPercept = {
        perceptorId: options.perceptorId ?? 'assistant.conversation',
        domain: 'assistant',
        kind: 'conversation_turn',
        subject: { type: 'conversation', id: options.userId ?? 'anonymous' },
        observedAt: new Date(),
        // A plain turn is mid-salience: worth encoding, not automatically worth
        // remembering. What lifts it is corroboration at L3 — the same thing
        // being said or asked repeatedly across turns.
        salience: 0.4,
        confidence: 0.6,
        features: { questionLength: question.length, answerLength: answer.length },
        summary: question.slice(0, 200) || answer.slice(0, 200),
        payload: { question, answer },
        tags: ['assistant', 'conversation'],
      };

      // The turn must never fail the chain. A conversation that errors because
      // its own bookkeeping failed is a worse outcome than a turn that is not
      // learned from.
      try {
        await network.perceive({ domain: 'assistant', percepts: [percept], trigger: 'conversation' });
      } catch {
        /* learning is best-effort; the user's turn already succeeded */
      }
    },
  };
}
