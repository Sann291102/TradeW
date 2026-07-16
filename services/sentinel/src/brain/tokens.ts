/**
 * DI tokens for the Brain's interface-typed dependencies. NestJS resolves
 * concrete classes by type automatically, but ai-core's contracts
 * (MemoryStore, KnowledgeGraph, LearningEngine, ...) are plain TypeScript
 * interfaces with no runtime representation, so each needs an explicit
 * string token bound to a concrete implementation.
 */
export const PROVIDER_MANAGER = 'PROVIDER_MANAGER';
export const MEMORY_STORE = 'MEMORY_STORE';
export const KNOWLEDGE_GRAPH = 'KNOWLEDGE_GRAPH';
export const BASE_LEARNING_ENGINE = 'BASE_LEARNING_ENGINE';
export const RETRIEVER = 'RETRIEVER';
export const RESEARCH_ENGINE = 'RESEARCH_ENGINE';
export const NEURAL_BRAIN = 'NEURAL_BRAIN';
