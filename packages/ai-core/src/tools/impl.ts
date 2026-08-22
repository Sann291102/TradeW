import { ToolSpec } from '../providers/types';
import { RegisteredTool, ToolContext, ToolRegistry } from './interfaces';

/**
 * ⚠️ INSTANTIATED, NEVER POPULATED.
 *
 * The single construction site —
 * `services/tradew-ai/src/assistant/assistant.service.ts` — creates a
 * `DefaultToolRegistry` and registers nothing in it. No `register()` call for
 * a tool exists anywhere in `services/`, `apps/` or `scripts/`, so
 * `specsFor()` always returns `[]` and every `allowedTools` array in
 * `agents/sentinel/definitions.json` and `agents/tradew-ai/definitions.json` is inert. No agent in TradeW calls a tool today.
 *
 * The class is correct and ready; it simply has no tools yet. See
 * `docs/product-architecture/AGENT-LAYERS.md`.
 */

export class DefaultToolRegistry implements ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.spec.name, tool);
  }

  get(name: string): RegisteredTool | null {
    return this.tools.get(name) ?? null;
  }

  specsFor(allowedNames: string[]): ToolSpec[] {
    return allowedNames
      .map((name) => this.tools.get(name)?.spec)
      .filter((s): s is ToolSpec => Boolean(s));
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.handler(args, ctx);
  }
}
