import { ProviderManager, ProviderSelection } from './provider-manager';
import { AnthropicLlmProvider } from './impl/anthropic';
import {
  OpenAiCompatibleEmbeddingProvider,
  OpenAiCompatibleLlmProvider,
} from './impl/openai-compatible';
import { VoyageEmbeddingProvider } from './impl/voyage';
import {
  AnthropicWebSearchProvider,
  BraveResearchProvider,
  FirecrawlResearchProvider,
  TavilyResearchProvider,
} from './impl/research';

/**
 * Config-driven provider assembly. Which providers exist and in which order
 * they're preferred is decided entirely here, from configuration — consumer
 * code never references a provider name (locked decision Q5).
 */

export interface TierModels {
  fast: string;
  balanced: string;
  deep: string;
}

export interface ProvidersConfig {
  selection: ProviderSelection;
  anthropic?: { apiKey: string; baseUrl?: string; models?: TierModels };
  openai?: { apiKey: string; baseUrl?: string; models?: TierModels; embeddingModel?: string; embeddingDim?: number };
  nvidiaNim?: { apiKey?: string; baseUrl?: string; models?: TierModels; embeddingModel?: string; embeddingDim?: number };
  ollama?: { baseUrl?: string; models?: TierModels };
  voyage?: { apiKey: string; model?: string; dimensions?: number };
  tavily?: { apiKey: string };
  brave?: { apiKey: string };
  firecrawl?: { apiKey: string };
  /** defaults to reusing anthropic.apiKey when omitted */
  anthropicWebSearch?: { apiKey?: string; model?: string };
}

const OPENAI_DEFAULT_MODELS: TierModels = { fast: 'gpt-4o-mini', balanced: 'gpt-4o', deep: 'o3' };
const NIM_DEFAULT_MODELS: TierModels = {
  fast: 'meta/llama-3.2-3b-instruct',
  balanced: 'meta/llama-3.1-8b-instruct',
  deep: 'nvidia/llama-3.3-nemotron-super-49b-v1',
};
const OLLAMA_DEFAULT_MODELS: TierModels = { fast: 'llama3.2', balanced: 'llama3.1', deep: 'llama3.1:70b' };

export function createProviderManager(config: ProvidersConfig): ProviderManager {
  const manager = new ProviderManager(config.selection);

  if (config.anthropic) {
    manager.registerLlm(new AnthropicLlmProvider(config.anthropic));
  }
  if (config.openai) {
    manager.registerLlm(
      new OpenAiCompatibleLlmProvider({
        name: 'openai',
        baseUrl: config.openai.baseUrl ?? 'https://api.openai.com/v1',
        apiKey: config.openai.apiKey,
        models: config.openai.models ?? OPENAI_DEFAULT_MODELS,
      }),
    );
    if (config.openai.embeddingModel) {
      manager.registerEmbedding(
        new OpenAiCompatibleEmbeddingProvider({
          name: 'openai',
          baseUrl: config.openai.baseUrl ?? 'https://api.openai.com/v1',
          apiKey: config.openai.apiKey,
          model: config.openai.embeddingModel,
          dimensions: config.openai.embeddingDim ?? 1536,
        }),
      );
    }
  }
  if (config.nvidiaNim) {
    const baseUrl = config.nvidiaNim.baseUrl ?? 'https://integrate.api.nvidia.com/v1';
    manager.registerLlm(
      new OpenAiCompatibleLlmProvider({
        name: 'nvidia-nim',
        baseUrl,
        apiKey: config.nvidiaNim.apiKey,
        models: config.nvidiaNim.models ?? NIM_DEFAULT_MODELS,
      }),
    );
    if (config.nvidiaNim.embeddingModel) {
      manager.registerEmbedding(
        new OpenAiCompatibleEmbeddingProvider({
          name: 'nvidia-nim',
          baseUrl,
          apiKey: config.nvidiaNim.apiKey,
          model: config.nvidiaNim.embeddingModel,
          dimensions: config.nvidiaNim.embeddingDim ?? 1024,
        }),
      );
    }
  }
  if (config.ollama) {
    manager.registerLlm(
      new OpenAiCompatibleLlmProvider({
        name: 'ollama',
        baseUrl: config.ollama.baseUrl ?? 'http://localhost:11434/v1',
        models: config.ollama.models ?? OLLAMA_DEFAULT_MODELS,
      }),
    );
  }
  if (config.voyage) {
    manager.registerEmbedding(new VoyageEmbeddingProvider(config.voyage));
  }
  if (config.tavily) {
    manager.registerResearch(new TavilyResearchProvider(config.tavily));
  }
  if (config.brave) {
    manager.registerResearch(new BraveResearchProvider(config.brave));
  }
  if (config.firecrawl) {
    manager.registerResearch(new FirecrawlResearchProvider(config.firecrawl));
  }
  const webSearchKey = config.anthropicWebSearch?.apiKey ?? config.anthropic?.apiKey;
  if (webSearchKey) {
    manager.registerResearch(
      new AnthropicWebSearchProvider({ apiKey: webSearchKey, model: config.anthropicWebSearch?.model }),
    );
  }

  return manager;
}

/**
 * Environment-variable loader — one env surface shared by every service that
 * boots ai-core. Missing keys simply mean that provider isn't registered.
 *
 *   AI_LLM_ORDER / AI_EMBEDDING_ORDER / AI_RESEARCH_ORDER  comma-separated
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, NVIDIA_NIM_API_KEY (+ NVIDIA_NIM_BASE_URL),
 *   OLLAMA_BASE_URL, VOYAGE_API_KEY, TAVILY_API_KEY, BRAVE_API_KEY, FIRECRAWL_API_KEY
 */
export function loadProvidersConfigFromEnv(env: Record<string, string | undefined> = process.env): ProvidersConfig {
  const order = (key: string, fallback: string[]) =>
    env[key]
      ? env[key]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : fallback;

  return {
    selection: {
      llm: order('AI_LLM_ORDER', ['anthropic', 'nvidia-nim', 'openai', 'ollama']),
      embedding: order('AI_EMBEDDING_ORDER', ['voyage', 'nvidia-nim', 'openai']),
      research: order('AI_RESEARCH_ORDER', ['tavily', 'brave', 'anthropic-web-search', 'firecrawl']),
    },
    ...(env.ANTHROPIC_API_KEY ? { anthropic: { apiKey: env.ANTHROPIC_API_KEY } } : {}),
    ...(env.OPENAI_API_KEY
      ? { openai: { apiKey: env.OPENAI_API_KEY, embeddingModel: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small' } }
      : {}),
    ...(env.NVIDIA_NIM_API_KEY || env.NVIDIA_NIM_BASE_URL
      ? {
          nvidiaNim: {
            apiKey: env.NVIDIA_NIM_API_KEY,
            baseUrl: env.NVIDIA_NIM_BASE_URL,
            ...(env.NVIDIA_NIM_EMBEDDING_MODEL ? { embeddingModel: env.NVIDIA_NIM_EMBEDDING_MODEL } : {}),
          },
        }
      : {}),
    ...(env.OLLAMA_BASE_URL ? { ollama: { baseUrl: env.OLLAMA_BASE_URL } } : {}),
    ...(env.VOYAGE_API_KEY ? { voyage: { apiKey: env.VOYAGE_API_KEY, model: env.VOYAGE_MODEL } } : {}),
    ...(env.TAVILY_API_KEY ? { tavily: { apiKey: env.TAVILY_API_KEY } } : {}),
    ...(env.BRAVE_API_KEY ? { brave: { apiKey: env.BRAVE_API_KEY } } : {}),
    ...(env.FIRECRAWL_API_KEY ? { firecrawl: { apiKey: env.FIRECRAWL_API_KEY } } : {}),
  };
}
