import { ToolSpec } from '../providers/types';
import { RegisteredTool, ToolContext, ToolRegistry } from './interfaces';

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
