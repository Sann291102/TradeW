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
  /**
   * Vendor-specific fields merged into the request body verbatim — the escape
   * hatch for params outside the OpenAI schema. Config-supplied only, so no
   * provider name ever leaks into consumer code (locked decision Q5).
   * NIM reasoning models use it for `chat_template_kwargs.enable_thinking`.
   * Never overrides a field the request itself set.
   */
  extraBody?: Record<string, unknown>;
  /** applied when the request doesn't specify topP */
  defaultTopP?: number;
  /** abort a hung/queued call instead of blocking a worker forever */
  timeoutMs?: number;
  /**
   * How `request.jsonMode` is expressed on the wire. OpenAI accepts a bare
   * `{type:'json_object'}`; the vLLM build behind NVIDIA NIM rejects it with a
   * 400 unless a schema comes with it, so those endpoints use 'omit' and lean
   * on the prompt instead. Defaults to 'json_object'.
   */
  jsonModeStrategy?: 'json_object' | 'omit';
}

/**
 * Reasoning models return their chain-of-thought either in a sibling field
 * (`reasoning` on NIM/vLLM, `reasoning_content` on others) or inline in a
 * <think> block. Split it off so callers get a clean answer in `text` and the
 * trace stays available for audit only.
 */
function splitReasoning(
  content: string,
  message: { reasoning?: string | null; reasoning_content?: string | null },
): { text: string; reasoning?: string } {
  const sibling = message.reasoning ?? message.reasoning_content ?? undefined;
  const inline: string[] = [];
  const stripped = content
    .replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi, (_m, _tag, body: string) => {
      inline.push(body.trim());
      return '';
    })
    // an unterminated <think> means max_tokens cut the trace off mid-stream
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, (m) => {
      inline.push(m.replace(/^<[^>]+>/, '').trim());
      return '';
    })
    .trim();

  const reasoning = [sibling?.trim(), ...inline].filter(Boolean).join('\n\n') || undefined;
  // Reasoning is NEVER promoted into `text`, even when the model burned its
  // whole max_tokens budget thinking and left no answer. An empty string is a
  // failure the caller can detect; leaked chain-of-thought rendered as a
  // Sentinel observation is not (observation-only contract, ARCHITECTURE.md).
  return { text: stripped, reasoning };
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

    const topP = request.topP ?? this.config.defaultTopP;
    const body: Record<string, unknown> = {
      // extraBody first so explicit request fields always win
      ...this.config.extraBody,
      model,
      messages,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(request.stopSequences ? { stop: request.stopSequences } : {}),
      ...(request.jsonMode && (this.config.jsonModeStrategy ?? 'json_object') === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        ...(this.config.timeoutMs ? { signal: AbortSignal.timeout(this.config.timeoutMs) } : {}),
      });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
        throw new Error(
          `${this.name} completion timed out after ${this.config.timeoutMs}ms (model ${model}). ` +
            `Some hosted models queue for minutes on the free tier — raise the timeout or pick a faster model.`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      throw new Error(`${this.name} completion failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: {
        message: {
          content: string | null;
          reasoning?: string | null;
          reasoning_content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
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

    const { text, reasoning } = splitReasoning(choice.message.content ?? '', choice.message);

    return {
      text,
      toolCalls,
      stopReason: stopMap[choice.finish_reason] ?? 'other',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      ...(reasoning ? { reasoning } : {}),
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
