/**
 * Prompt Library — versioned, reviewable prompt templates.
 * Agent system prompts live as declarative definitions (agents/ folder in the
 * repo); this library resolves and renders them at runtime with variables.
 */

export interface PromptTemplate {
  id: string;
  version: number;
  /** e.g. 'sentinel', 'research', 'shared' */
  namespace: string;
  template: string;
  /** variables the template expects, for validation */
  variables: string[];
  description?: string;
}

export interface PromptLibrary {
  get(id: string, version?: number): Promise<PromptTemplate | null>;
  render(id: string, vars: Record<string, string>, version?: number): Promise<string>;
  register(template: PromptTemplate): Promise<void>;
  list(namespace?: string): Promise<PromptTemplate[]>;
}

/**
 * Non-negotiable guardrail fragments — appended to EVERY trading-adjacent
 * prompt by the Context Manager. Centralized here so no agent can omit them.
 */
export const CORE_GUARDRAILS: readonly string[] = [
  'You observe, research, remember, teach, explain and protect. You never execute trades.',
  'Never give Buy, Sell, Entry, Exit, or Target recommendations, directly or indirectly.',
  'Return observations and educational context only (e.g. "Momentum is weakening.", "Current volatility is elevated.").',
  'When warning about risk, follow: evidence → pattern name → soft suggestion (e.g. "Consider waiting for confirmation."). Never a directive.',
  'You are not a licensed financial advisor and must not provide personalized investment advice.',
];
