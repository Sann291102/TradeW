/**
 * @tradew/ai-core — the shared AI foundation of TradeW.
 *
 * Every TradeW AI product (Sentinel, TradeW AI Research, Portfolio Intelligence,
 * Education AI, future agents) depends on this package for intelligence
 * primitives. No product implements its own provider calls, memory, retrieval
 * or agent runtime — they compose these contracts.
 *
 * Layer map:
 *   domain/     shared knowledge types (MemoryRecord, EntityRef, provenance)
 *   providers/  LLM / Embedding / Research provider contracts + ProviderManager
 *   memory/     Memory Engine (semantic store) + VectorStore
 *   graph/      Knowledge Graph (SQL-backed nodes/edges)
 *   rag/        Retrieval + chunking
 *   research/   Research Engine (validate → summarize → embed → connect → store)
 *   brain/      Neural Brain pipeline + Learning Engine
 *   context/    Context Manager (token-budgeted prompt assembly)
 *   prompts/    Prompt Library + CORE_GUARDRAILS (never-advise contract)
 *   tools/      Tool Registry (no order-placement tools, by design)
 *   agents/     Agent SDK (declarative definitions + runtime contract)
 */

export * from './domain/knowledge';
export * from './providers/types';
export * from './providers/interfaces';
export * from './providers/provider-manager';
export * from './providers/factory';
export * from './providers/impl/anthropic';
export * from './providers/impl/openai-compatible';
export * from './providers/impl/voyage';
export * from './providers/impl/research';
export * from './memory/interfaces';
export * from './memory/in-memory';
export * from './graph/interfaces';
export * from './rag/interfaces';
export * from './rag/impl';
export * from './research/interfaces';
export * from './research/impl';
export * from './brain/interfaces';
export * from './brain/impl';
export * from './context/interfaces';
export * from './context/impl';
export * from './prompts/interfaces';
export * from './prompts/impl';
export * from './tools/interfaces';
export * from './tools/impl';
export * from './agents/interfaces';
export * from './agents/impl';
export * from './news/news-event-classifier';
