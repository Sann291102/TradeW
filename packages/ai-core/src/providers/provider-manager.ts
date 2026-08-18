import { instrumentLlmProvider } from '../telemetry/instrument';
import { EmbeddingProvider, LlmProvider, ResearchProvider } from './interfaces';

/**
 * ProviderManager — the single place providers are registered and selected.
 *
 * Rules (locked decision Q5):
 * - Consumers (Brain, Research Engine, Sentinel, TradeW AI) NEVER import a
 *   concrete provider. They ask the manager for the active capability.
 * - Primary/fallback order comes from configuration, never code.
 * - Adding a provider = implement the interface + register it; zero changes
 *   anywhere else.
 */

export interface ProviderSelection {
  /** ordered preference, e.g. ['anthropic', 'nvidia-nim', 'openai', 'ollama'] */
  llm: string[];
  /** e.g. ['voyage', 'nvidia-nim', 'openai'] */
  embedding: string[];
  /** e.g. ['tavily', 'brave', 'anthropic-web-search', 'firecrawl'] */
  research: string[];
}

export class ProviderNotAvailableError extends Error {
  constructor(capability: string, tried: string[]) {
    super(
      `No ${capability} provider available. Tried (in configured order): ${tried.join(', ') || '<none registered>'}`,
    );
    this.name = 'ProviderNotAvailableError';
  }
}

export class ProviderManager {
  private llms = new Map<string, LlmProvider>();
  private embedders = new Map<string, EmbeddingProvider>();
  private researchers = new Map<string, ResearchProvider>();

  constructor(
    private selection: ProviderSelection,
    /**
     * Telemetry wrapping on LLM registration. On by default, and this is the
     * single chokepoint that makes the admin portal's AI view trustworthy: a
     * provider that is reachable through the manager is, by construction,
     * instrumented. Wrapping at each call site instead would mean the portal
     * silently under-reports whenever someone adds a provider and forgets.
     *
     * Turn it off in tests that assert provider identity (`getLlm() === stub`),
     * where the wrapper's separate object would be the only thing failing.
     */
    private readonly instrument: boolean = true,
  ) {}

  registerLlm(provider: LlmProvider): void {
    this.llms.set(provider.name, this.instrument ? instrumentLlmProvider(provider) : provider);
  }

  registerEmbedding(provider: EmbeddingProvider): void {
    this.embedders.set(provider.name, provider);
  }

  registerResearch(provider: ResearchProvider): void {
    this.researchers.set(provider.name, provider);
  }

  /** Update preference order at runtime (e.g. config reload, admin override). */
  updateSelection(selection: Partial<ProviderSelection>): void {
    this.selection = { ...this.selection, ...selection };
  }

  getLlm(): LlmProvider {
    return this.pick('LLM', this.selection.llm, this.llms);
  }

  getEmbedding(): EmbeddingProvider {
    return this.pick('embedding', this.selection.embedding, this.embedders);
  }

  getResearch(): ResearchProvider {
    return this.pick('research', this.selection.research, this.researchers);
  }

  /** All registered research providers in preference order (multi-source sweeps). */
  getAllResearch(): ResearchProvider[] {
    return this.selection.research
      .map((name) => this.researchers.get(name))
      .filter((p): p is ResearchProvider => Boolean(p));
  }

  private pick<T>(capability: string, order: string[], registry: Map<string, T>): T {
    for (const name of order) {
      const provider = registry.get(name);
      if (provider) return provider;
    }
    throw new ProviderNotAvailableError(capability, order);
  }
}
