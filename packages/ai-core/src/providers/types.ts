/**
 * Provider-agnostic request/response shapes.
 * No provider names appear anywhere in these types — providers are selected
 * by configuration through the ProviderManager, never hardcoded (locked decision Q5).
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** present when role === 'tool' */
  toolCallId?: string;
  /** present when the assistant requested tool calls */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments */
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input */
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** logical model tier, mapped per-provider by configuration */
  tier?: 'fast' | 'balanced' | 'deep';
  /** explicit provider-specific model id override (config-driven only) */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** nucleus sampling; providers that don't support it ignore the field */
  topP?: number;
  tools?: ToolSpec[];
  /** force JSON output when supported */
  jsonMode?: boolean;
  stopSequences?: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'end' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'other';
  usage: TokenUsage;
  /**
   * Chain-of-thought emitted by reasoning models, separated from `text` so
   * consumers never render it. Kept for the audit trail only — Sentinel
   * surfaces `text`, never this (observation-only contract).
   */
  reasoning?: string;
  /** which provider/model actually served the request (for audit logging) */
  servedBy: { provider: string; model: string };
}

export interface EmbeddingRequest {
  texts: string[];
  /** 'document' at ingest time, 'query' at search time (providers may optimize) */
  inputType?: 'document' | 'query';
}

export interface EmbeddingResponse {
  embeddings: number[][];
  dimensions: number;
  usage?: { totalTokens: number };
  servedBy: { provider: string; model: string };
}

export interface ResearchQuery {
  query: string;
  maxResults?: number;
  /** restrict to recent content, in days */
  recencyDays?: number;
  /** optional domain allow-list */
  includeDomains?: string[];
}

export interface ResearchResult {
  title: string;
  url: string;
  snippet: string;
  /** full extracted content when the provider supports it */
  content?: string;
  publishedAt?: Date;
  score?: number;
  servedBy: { provider: string };
}
