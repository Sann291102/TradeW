import { Injectable, Logger } from '@nestjs/common';
import {
  CORE_GUARDRAILS,
  ProviderManager,
  ProviderNotAvailableError,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';

export interface ExplainResult {
  answer: string;
  /** true only when a real configured LLM provider produced the answer */
  live: boolean;
  servedBy?: { provider: string; model: string };
}

/**
 * Backs the terminal's "Explain this decision / Explain this module" links
 * with the real Neural Brain (via the provider layer) instead of a canned
 * client-side string. Honesty over polish: when no LLM provider is
 * configured, this returns a clearly-labelled deterministic explanation
 * rather than faking an AI-authored one — never blocked by a provider
 * outage, per the same design used by the orchestrator's synthesis.
 */
@Injectable()
export class ExplainService {
  private readonly logger = new Logger(ExplainService.name);
  private providers: ProviderManager;

  constructor() {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  async explain(question: string, context?: string): Promise<ExplainResult> {
    try {
      const llm = this.providers.getLlm();
      const response = await llm.complete({
        tier: 'fast',
        maxTokens: 320,
        messages: [
          {
            role: 'system',
            content:
              `You are Sentinel, TradeW's AI market-safety co-pilot. Explain the given module/decision in plain, calm, educational language — what it measured, why it reached this reading, and what a trader should be aware of. Never tell the user to buy, sell, enter, exit, or give a price target.\n\nNon-negotiable rules:\n` +
              CORE_GUARDRAILS.map((g) => `- ${g}`).join('\n'),
          },
          {
            role: 'user',
            content: context ? `${question}\n\nContext:\n${context}` : question,
          },
        ],
      });
      const answer = response.text.trim();
      if (answer) return { answer, live: true, servedBy: response.servedBy };
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(`explain LLM call failed, using deterministic fallback: ${err}`);
      }
    }
    return {
      answer:
        'Sentinel is running without a configured AI provider right now, so this is a deterministic note rather than a generated explanation: the module reading above is computed directly from live market/behavioral signals — the evidence lines under it are the full basis for the reading, not a summary of something more. Configure an LLM provider (Anthropic, NVIDIA NIM, OpenAI, or a local Ollama model) to get plain-language, contextual explanations here.',
      live: false,
    };
  }
}
