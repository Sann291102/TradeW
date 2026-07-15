import {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ResearchQuery,
  ResearchResult,
} from './types';

/**
 * The three provider capabilities of the AI Provider Layer.
 * Initial roster (config-driven, all swappable — locked decision Q5):
 *   LLM:        anthropic (primary), nvidia-nim, openai, ollama
 *   Embeddings: voyage (primary), nvidia-nim, openai
 *   Research:   tavily (primary), brave, anthropic-web-search, firecrawl
 */

export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** cheap connectivity/credential check for health endpoints */
  healthCheck(): Promise<boolean>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  healthCheck(): Promise<boolean>;
}

export interface ResearchProvider {
  readonly name: string;
  search(query: ResearchQuery): Promise<ResearchResult[]>;
  healthCheck(): Promise<boolean>;
}
