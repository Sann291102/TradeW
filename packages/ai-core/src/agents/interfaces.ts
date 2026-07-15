import { ChatMessage } from '../providers/types';

/**
 * Agent SDK — declarative agent definitions + the runtime contract.
 *
 * Definitions are version-controlled files (agents/sentinel/, agents/tradew-ai/)
 * reviewed like code (ARCHITECTURE.md §4). A runtime service loads only its own
 * system's definitions and executes them against ai-core primitives.
 */

export interface AgentDefinition {
  name: string;
  /** which product system owns it: 'sentinel' | 'tradew-ai' | future systems */
  system: string;
  description: string;
  /** prompt template id in the Prompt Library */
  systemPromptId: string;
  /** tool names this agent may call (resolved via ToolRegistry) */
  allowedTools: string[];
  /** extra guardrail fragments appended after CORE_GUARDRAILS */
  guardrails: string[];
  /** disclaimer attached to user-visible output, if any */
  disclaimer?: string;
  /** logical model tier */
  tier: 'fast' | 'balanced' | 'deep';
  /** entitlement capability required to invoke this agent */
  requiredCapability?: string;
}

export interface AgentInvocation {
  agentName: string;
  userId: string | null;
  input: string;
  history?: ChatMessage[];
  /** structured context the caller provides (market snapshot, behavior stats…) */
  data?: Record<string, unknown>;
}

export interface AgentResult {
  agentName: string;
  /** user-facing text (only orchestrators produce user-facing copy in Sentinel) */
  output: string;
  /** machine-readable observations for downstream synthesis */
  structured?: Record<string, unknown>;
  /** every tool call made, for the audit trail */
  toolTrace: { tool: string; args: Record<string, unknown>; ok: boolean }[];
  usage: { inputTokens: number; outputTokens: number };
  disclaimer?: string;
}

export interface AgentRuntime {
  load(definitions: AgentDefinition[]): void;
  get(name: string): AgentDefinition | null;
  invoke(invocation: AgentInvocation): Promise<AgentResult>;
}
