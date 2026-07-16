import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CORE_GUARDRAILS,
  ProviderManager,
  ProviderNotAvailableError,
  Retriever,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { RETRIEVER } from '../brain/tokens';

export interface ExplainTrace {
  /** the raw evidence lines the caller supplied (e.g. a module's readings) */
  evidenceUsed: string[];
  /** Brain memory records that contributed additional context, if any */
  memoryHits: { summary: string; confidence: number }[];
}

export interface ExplainResult {
  answer: string;
  /** true only when a real configured LLM provider produced the answer */
  live: boolean;
  servedBy?: { provider: string; model: string };
  /** Explainability Engine: exactly what fed this answer — never a black box */
  trace: ExplainTrace;
}

/**
 * Backs the terminal's "Explain this decision / Explain this module" links
 * with the real Neural Brain instead of a canned client-side string, AND
 * makes the answer traceable: every response reports the evidence lines
 * and any relevant Brain memories it drew on, not just prose. Honesty over
 * polish: with no LLM provider configured, this returns a clearly-labelled
 * deterministic explanation — never a faked AI-authored one.
 */
@Injectable()
export class ExplainService {
  private readonly logger = new Logger(ExplainService.name);
  private providers: ProviderManager;

  constructor(@Inject(RETRIEVER) private readonly retriever: Retriever) {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  async explain(question: string, context?: string): Promise<ExplainResult> {
    const evidenceUsed = context ? context.split('\n').filter(Boolean) : [];

    let memoryHits: ExplainTrace['memoryHits'] = [];
    try {
      const retrieval = await this.retriever.retrieve({ query: question, namespace: 'sentinel', limit: 3 });
      memoryHits = retrieval.hits.map((h) => ({ summary: h.record.summary, confidence: h.record.confidence }));
    } catch (err) {
      this.logger.warn(`explain: Brain memory retrieval failed (non-fatal): ${err}`);
    }
    const trace: ExplainTrace = { evidenceUsed, memoryHits };

    try {
      const llm = this.providers.getLlm();
      const memoryContext = memoryHits.length ? `\n\nRelevant Brain memory:\n${memoryHits.map((h) => `- ${h.summary}`).join('\n')}` : '';
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
            content: (context ? `${question}\n\nContext:\n${context}` : question) + memoryContext,
          },
        ],
      });
      const answer = response.text.trim();
      if (answer) return { answer, live: true, servedBy: response.servedBy, trace };
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(`explain LLM call failed, using deterministic fallback: ${err}`);
      }
    }
    return {
      answer:
        'Sentinel is running without a configured AI provider right now, so this is a deterministic note rather than a generated explanation: the module reading above is computed directly from live market/behavioral signals — the evidence lines under it are the full basis for the reading, not a summary of something more. Configure an LLM provider (Anthropic, NVIDIA NIM, OpenAI, or a local Ollama model) to get plain-language, contextual explanations here.',
      live: false,
      trace,
    };
  }
}
