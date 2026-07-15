import { EmbeddingProvider, LlmProvider } from '../interfaces';
import { CompletionRequest, CompletionResponse, EmbeddingRequest, EmbeddingResponse, ToolCall } from '../types';

/**
 * One adapter, three providers: OpenAI, NVIDIA NIM and Ollama all speak the
 * OpenAI-compatible chat/completions + embeddings API. Which one this instance
 * talks to is purely a matter of `name` + `baseUrl` + `models` config:
 *   openai:     https://api.openai.com/v1
 *   nvidia-nim: https://integrate.api.nvidia.com/v1 (hosted) or a self-hosted
 *               NIM endpoint (e.g. http://nim.internal/v1) — including a
 *               distilled student model produced by the NeMo Data Flywheel
 *   ollama:     http://localhost:11434/v1
 */
export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: { fast: string; balanced: string; deep: string };
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name: string;
  private baseUrl: string;

  constructor(private config: OpenAiCompatibleConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.config.models[request.tier ?? 'balanced'];
    const messages = request.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences ? { stop: request.stopSequences } : {}),
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${this.name} completion failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: {
        message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
      model?: string;
    };

    const choice = data.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    const stopMap: Record<string, CompletionResponse['stopReason']> = {
      stop: 'end',
      length: 'max_tokens',
      tool_calls: 'tool_use',
    };

    return {
      text: choice.message.content ?? '',
      toolCalls,
      stopReason: stopMap[choice.finish_reason] ?? 'other',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      servedBy: { provider: this.name, model: data.model ?? model },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export interface OpenAiCompatibleEmbeddingConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions: number;
}

/** Embeddings via the OpenAI-compatible /embeddings endpoint (OpenAI, NVIDIA NIM). */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private baseUrl: string;

  constructor(private config: OpenAiCompatibleEmbeddingConfig) {
    this.name = config.name;
    this.dimensions = config.dimensions;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const body: Record<string, unknown> = { model: this.config.model, input: request.texts };
    // NVIDIA NIM retrieval models require input_type ('query' | 'passage')
    if (this.name === 'nvidia-nim') {
      body.input_type = request.inputType === 'query' ? 'query' : 'passage';
    }
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${this.name} embeddings failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: { embedding: number[] }[];
      usage?: { total_tokens: number };
      model?: string;
    };
    return {
      embeddings: data.data.map((d) => d.embedding),
      dimensions: data.data[0]?.embedding.length ?? this.dimensions,
      usage: data.usage ? { totalTokens: data.usage.total_tokens } : undefined,
      servedBy: { provider: this.name, model: data.model ?? this.config.model },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
