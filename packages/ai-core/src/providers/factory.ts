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
  nvidiaNim?: {
    apiKey?: string;
    baseUrl?: string;
    models?: TierModels;
    embeddingModel?: string;
    embeddingDim?: number;
    /** merged into every chat body (e.g. { chat_template_kwargs: { enable_thinking: true } }) */
    extraBody?: Record<string, unknown>;
    topP?: number;
    timeoutMs?: number;
  };
  ollama?: { baseUrl?: string; models?: TierModels };
  voyage?: { apiKey: string; model?: string; dimensions?: number };
  tavily?: { apiKey: string };
  brave?: { apiKey: string };
  firecrawl?: { apiKey: string };
  /** defaults to reusing anthropic.apiKey when omitted */
  anthropicWebSearch?: { apiKey?: string; model?: string };
}

const OPENAI_DEFAULT_MODELS: TierModels = { fast: 'gpt-4o-mini', balanced: 'gpt-4o', deep: 'o3' };
/**
 * Measured on the NIM free tier 2026-07-23, not chosen by parameter count.
 * `meta/llama-3.2-3b-instruct` was the previous `fast` default and is NOT safe
 * to return to: it timed out twice in four 220-token prose calls and never
 * answered a tool-calling request at all (240s, zero bytes). The 8b is both
 * faster (sub-second warm) and the smallest model here that reliably emits
 * tool_calls — which the agent runtime in agents/impl.ts depends on.
 */
const NIM_DEFAULT_MODELS: TierModels = {
  fast: 'meta/llama-3.1-8b-instruct',
  balanced: 'nvidia/llama-3.3-nemotron-super-49b-v1',
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
        ...(config.nvidiaNim.extraBody ? { extraBody: config.nvidiaNim.extraBody } : {}),
        ...(config.nvidiaNim.topP !== undefined ? { defaultTopP: config.nvidiaNim.topP } : {}),
        timeoutMs: config.nvidiaNim.timeoutMs ?? 300_000,
        // NIM runs vLLM, which rejects bare {type:'json_object'} with a 400 and
        // demands a json_schema/guided_json. We have no schema on the request,
        // so drop the flag and rely on the prompt (which already asks for JSON).
        jsonModeStrategy: 'omit',
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
 *
 * NIM tuning (all optional): NVIDIA_NIM_MODEL_FAST / _BALANCED / _DEEP pin a
 * model per tier, NVIDIA_NIM_ENABLE_THINKING toggles reasoning on models that
 * gate it, NVIDIA_NIM_TOP_P and NVIDIA_NIM_TIMEOUT_MS tune sampling/patience.
 */
export function loadProvidersConfigFromEnv(env: Record<string, string | undefined> = process.env): ProvidersConfig {
  const order = (key: string, fallback: string[]) =>
    env[key]
      ? env[key]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : fallback;

  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * Per-tier model overrides. Any tier left unset falls back to the built-in
   * default, so pinning just one model (e.g. deep) is a one-line env change.
   */
  const tierModels = (prefix: string, defaults: TierModels): TierModels | undefined => {
    const models: TierModels = {
      fast: env[`${prefix}_MODEL_FAST`]?.trim() || defaults.fast,
      balanced: env[`${prefix}_MODEL_BALANCED`]?.trim() || defaults.balanced,
      deep: env[`${prefix}_MODEL_DEEP`]?.trim() || defaults.deep,
    };
    const overridden =
      models.fast !== defaults.fast || models.balanced !== defaults.balanced || models.deep !== defaults.deep;
    return overridden ? models : undefined;
  };

  const nimModels = tierModels('NVIDIA_NIM', NIM_DEFAULT_MODELS);

  return {
    selection: {
      llm: order('AI_LLM_ORDER', ['anthropic', 'nvidia-nim', 'openai', 'ollama']),
      embedding: order('AI_EMBEDDING_ORDER', ['voyage', 'nvidia-nim', 'openai']),
      research: order('AI_RESEARCH_ORDER', ['tavily', 'brave', 'anthropic-web-search', 'firecrawl']),
    },
    // ANTHROPIC_TIMEOUT_MS is overridable but never absent — the provider
    // defaults it, because a completion with no ceiling defeats the caller's
    // fallback rather than merely slowing it. See `AnthropicConfig.timeoutMs`.
    ...(env.ANTHROPIC_API_KEY
      ? {
          anthropic: {
            apiKey: env.ANTHROPIC_API_KEY,
            ...(env.ANTHROPIC_TIMEOUT_MS ? { timeoutMs: Number(env.ANTHROPIC_TIMEOUT_MS) } : {}),
          },
        }
      : {}),
    ...(env.OPENAI_API_KEY
      ? { openai: { apiKey: env.OPENAI_API_KEY, embeddingModel: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small' } }
      : {}),
    ...(env.NVIDIA_NIM_API_KEY || env.NVIDIA_NIM_BASE_URL
      ? {
          nvidiaNim: {
            apiKey: env.NVIDIA_NIM_API_KEY,
            baseUrl: env.NVIDIA_NIM_BASE_URL,
            ...(env.NVIDIA_NIM_EMBEDDING_MODEL ? { embeddingModel: env.NVIDIA_NIM_EMBEDDING_MODEL } : {}),
            ...(nimModels ? { models: nimModels } : {}),
            // reasoning models (e.g. google/diffusiongemma-26b-a4b-it) gate their
            // chain-of-thought behind a chat-template flag rather than a param
            ...(env.NVIDIA_NIM_ENABLE_THINKING !== undefined
              ? { extraBody: { chat_template_kwargs: { enable_thinking: env.NVIDIA_NIM_ENABLE_THINKING === 'true' } } }
              : {}),
            ...(num(env.NVIDIA_NIM_TOP_P) !== undefined ? { topP: num(env.NVIDIA_NIM_TOP_P) } : {}),
            ...(num(env.NVIDIA_NIM_TIMEOUT_MS) !== undefined ? { timeoutMs: num(env.NVIDIA_NIM_TIMEOUT_MS) } : {}),
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
