import { randomUUID } from 'crypto';
import { ContextManager } from '../context/interfaces';
import { CORE_GUARDRAILS, PromptLibrary } from '../prompts/interfaces';
import { ProviderManager } from '../providers/provider-manager';
import { ChatMessage } from '../providers/types';
import { ToolRegistry } from '../tools/interfaces';
import { AgentDefinition, AgentInvocation, AgentResult, AgentRuntime } from './interfaces';

/**
 * ⚠️ ONE CALLER, AND NOT THE ONE THE ARCHITECTURE DOCS DESCRIBE.
 *
 * `DefaultAgentRuntime` is instantiated in exactly one place —
 * `services/tradew-ai/src/assistant/assistant.service.ts` — where it runs a
 * single agent, `assistant-planner`, loaded from
 * `agents/tradew-ai/definitions.json`. That path is real and works.
 *
 * Everything else the docs attribute to this runtime does not exist:
 *
 *   - No `POST /agents/:name/invoke` route exists in any runtime, despite
 *     `ARCHITECTURE.md` §4 and `AGENT-ARCHITECTURE.md` §5 both specifying it.
 *     The one live surface is `POST /assistant/interpret`.
 *   - `agents/sentinel/definitions.json` is read by NO code. The five Sentinel
 *     definitions in it are entirely inert.
 *   - Sentinel runs no LLM-backed agents at all. Its ten agents are
 *     deterministic TypeScript classes implementing a different contract
 *     (`services/sentinel/src/sentinel-intelligence/agents/agent.contract.ts`).
 *   - `def.allowedTools` and `def.systemPromptId` are inert even on the live
 *     path: the sole caller passes an empty `DefaultToolRegistry` and an empty
 *     `InMemoryPromptLibrary`, so `specsFor()` returns `[]` and the prompt
 *     lookup misses, falling through to the synthesized
 *     "You are the {name} agent" string below.
 *
 * See `docs/product-architecture/AGENT-LAYERS.md` for the full map of which
 * agent layer runs and which is specification only.
 */

const MAX_TOOL_ROUNDS = 6;

/**
 * Default agent runtime: renders the agent's system prompt from the Prompt
 * Library, appends CORE_GUARDRAILS + agent guardrails (unremovable), then runs
 * a bounded tool-use loop against the ToolRegistry.
 */
export class DefaultAgentRuntime implements AgentRuntime {
  private definitions = new Map<string, AgentDefinition>();

  constructor(
    private deps: {
      providers: ProviderManager;
      prompts: PromptLibrary;
      tools: ToolRegistry;
      context: ContextManager;
    },
  ) {}

  load(definitions: AgentDefinition[]): void {
    for (const def of definitions) this.definitions.set(def.name, def);
  }

  get(name: string): AgentDefinition | null {
    return this.definitions.get(name) ?? null;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentResult> {
    const def = this.definitions.get(invocation.agentName);
    if (!def) throw new Error(`unknown agent: ${invocation.agentName}`);

    const template = await this.deps.prompts.get(def.systemPromptId);
    const systemPrompt = template
      ? await this.deps.prompts.render(def.systemPromptId, {})
      : `You are the ${def.name} agent. ${def.description}`;

    const assembled = this.deps.context.assemble({
      systemPrompt,
      guardrails: [...CORE_GUARDRAILS, ...def.guardrails],
      history: invocation.history,
      inlineContext: invocation.data ? JSON.stringify(invocation.data, null, 2) : undefined,
      userMessage: invocation.input,
      budget: { maxInputTokens: 8000, reservedOutputTokens: 1200 },
    });

    const llm = this.deps.providers.getLlm();
    const toolSpecs = this.deps.tools.specsFor(def.allowedTools);
    const invocationId = randomUUID();
    const messages: ChatMessage[] = [...assembled.messages];
    const toolTrace: AgentResult['toolTrace'] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finalText = '';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const completion = await llm.complete({
        messages,
        tier: def.tier,
        maxTokens: 1200,
        tools: toolSpecs.length ? toolSpecs : undefined,
      });
      usage = {
        inputTokens: usage.inputTokens + completion.usage.inputTokens,
        outputTokens: usage.outputTokens + completion.usage.outputTokens,
      };

      if (completion.stopReason !== 'tool_use' || completion.toolCalls.length === 0) {
        finalText = completion.text;
        break;
      }

      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });
      for (const call of completion.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          /* pass empty args; the tool will reject if required fields are missing */
        }
        let resultText: string;
        let ok = true;
        try {
          const result = await this.deps.tools.invoke(call.name, args, {
            userId: invocation.userId,
            agentName: def.name,
            invocationId,
          });
          resultText = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          ok = false;
          resultText = `tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
        toolTrace.push({ tool: call.name, args, ok });
        messages.push({ role: 'tool', content: resultText.slice(0, 8000), toolCallId: call.id });
      }
    }

    // structured observations: agents may end with a fenced JSON block
    let structured: Record<string, unknown> | undefined;
    const jsonMatch = finalText.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        structured = JSON.parse(jsonMatch[1]);
      } catch {
        /* not valid JSON — leave structured undefined */
      }
    }

    return {
      agentName: def.name,
      output: finalText,
      structured,
      toolTrace,
      usage,
      disclaimer: def.disclaimer,
    };
  }
}
