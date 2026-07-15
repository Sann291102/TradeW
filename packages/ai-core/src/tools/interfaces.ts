import { ToolSpec } from '../providers/types';

/**
 * Tool Registry — the capabilities agents may call.
 * Agents declare allowed tool names; the runtime resolves them here.
 * Tools are read/compute only in trading contexts — there is deliberately no
 * mechanism for a tool that places, modifies, or cancels an order.
 */

export interface ToolContext {
  userId: string | null;
  agentName: string;
  /** correlation id for audit logging */
  invocationId: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
  /** entitlement capability required to use this tool, if premium-gated */
  requiredCapability?: string;
}

export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  get(name: string): RegisteredTool | null;
  /** specs for the subset of tools an agent is allowed to use */
  specsFor(allowedNames: string[]): ToolSpec[];
  invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
