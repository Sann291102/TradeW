import { ChatMessage } from '../providers/types';
import { RetrievalResult } from '../rag/interfaces';

/**
 * Context Manager — assembles the final prompt context within a token budget.
 * Owns prioritization: system contract > guardrails > retrieved knowledge >
 * conversation history > inline data. Trimming is deterministic and logged.
 */

export interface ContextBudget {
  maxInputTokens: number;
  /** reserve for the model's answer */
  reservedOutputTokens: number;
}

export interface ContextAssemblyRequest {
  systemPrompt: string;
  guardrails: string[];
  retrieval?: RetrievalResult | null;
  history?: ChatMessage[];
  inlineContext?: string;
  userMessage: string;
  budget: ContextBudget;
}

export interface ContextAssemblyResult {
  messages: ChatMessage[];
  estimatedInputTokens: number;
  /** what was dropped to fit the budget, for observability */
  trimmed: { section: string; droppedTokens: number }[];
}

export interface ContextManager {
  assemble(request: ContextAssemblyRequest): ContextAssemblyResult;
  estimateTokens(text: string): number;
}
