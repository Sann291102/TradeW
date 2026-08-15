import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentDefinition,
  DefaultAgentRuntime,
  DefaultToolRegistry,
  InMemoryPromptLibrary,
  SimpleContextManager,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { parsePlan, type PlanDto } from './plan-schema';

/**
 * The conversation brain (AI-OPERATING-SYSTEM.md §3).
 *
 * Composes `@tradew/ai-core` primitives — it implements no provider call,
 * prompt assembly or agent loop of its own, per that package's own contract
 * ("no product implements its own provider calls… they compose these
 * contracts"). The agent roster is loaded from `agents/tradew-ai/definitions.json`,
 * which is version-controlled and reviewed like code (ARCHITECTURE.md §4).
 *
 * ── FAILS SOFT, ON PURPOSE ─────────────────────────────────────────────────
 *
 * If no LLM provider is configured, this service starts and answers — it just
 * answers "I don't understand" instead of throwing at boot. That matters
 * because the brain is the SECOND half of a two-stage resolver: the
 * deterministic grammar in `apps/web` handles navigation and quotes with no
 * network at all, and it must keep working when the key is missing, the
 * provider is down, or the bill went unpaid. A missing API key should degrade
 * the assistant, never break the workspace.
 */
@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);
  private runtime: DefaultAgentRuntime | null = null;
  private available = false;

  constructor() {
    try {
      const providersConfig = loadProvidersConfigFromEnv();
      const providers = createProviderManager(providersConfig);
      this.runtime = new DefaultAgentRuntime({
        providers,
        prompts: new InMemoryPromptLibrary(),
        tools: new DefaultToolRegistry(),
        context: new SimpleContextManager(),
      });
      this.runtime.load(loadDefinitions());
      this.available = true;
      this.log.log('assistant-planner loaded');
    } catch (err) {
      // Logged as a warning, not an error: an unconfigured brain is a supported
      // deployment state, not a fault.
      this.log.warn(
        `conversation brain unavailable — falling back to deterministic only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Turn an utterance plus workspace context into a validated plan.
   *
   * `context` is whatever `apps/web` chose to send (active route, selected
   * symbol, visible panels). It is passed to the model as inline data and is
   * never trusted to contain anything privileged — `services/api` is the only
   * component that knows who the user is.
   */
  async interpret(input: {
    utterance: string;
    context?: Record<string, unknown>;
    userId?: string | null;
  }): Promise<PlanDto & { model: 'llm' | 'unavailable' }> {
    if (!this.runtime || !this.available) {
      throw new ServiceUnavailableException('conversation brain not configured');
    }

    const result = await this.runtime.invoke({
      agentName: 'assistant-planner',
      userId: input.userId ?? null,
      input: input.utterance,
      data: input.context,
    });

    const plan = parsePlan(result.output);

    if (plan.dropped > 0) {
      // Never silent. A model emitting actions outside the vocabulary is the
      // single most important signal this service produces — it means either
      // the prompt has drifted or something is probing the boundary.
      this.log.warn(
        `dropped ${plan.dropped} invalid action(s) from assistant-planner for utterance: ${input.utterance.slice(0, 120)}`,
      );
    }

    // A plan with nothing in it and nothing to say is indistinguishable from a
    // crash. If validation removed everything the model produced, say that
    // plainly rather than returning an empty object the UI has to guess about.
    if (plan.steps.length === 0 && !plan.unsupported && !plan.needsAnalysis) {
      return {
        ...plan,
        unsupported:
          plan.dropped > 0
            ? "I understood you, but what I came up with wasn't something I'm allowed to do. Try naming the screen you want."
            : "I couldn't work out what to do with that.",
        model: 'llm',
      };
    }

    return { ...plan, model: 'llm' };
  }
}

/**
 * Load the declarative roster. Resolved relative to the repo root rather than
 * to `__dirname`, because `__dirname` differs between `nest start` (src/) and
 * `start:prod` (dist/) and the definitions live in neither.
 */
function loadDefinitions(): AgentDefinition[] {
  const path =
    process.env.TRADEW_AI_DEFINITIONS ??
    resolve(__dirname, '../../../../agents/tradew-ai/definitions.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { agents: AgentDefinition[] };
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error(`no agents in ${path}`);
  }
  // This runtime loads ONLY its own system's definitions (ARCHITECTURE.md §4) —
  // a stray sentinel agent in this file must not become invocable here.
  return raw.agents.filter((a) => a.system === 'tradew-ai');
}
