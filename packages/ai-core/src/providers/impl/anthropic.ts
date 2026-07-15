import { LlmProvider } from '../interfaces';
import { ChatMessage, CompletionRequest, CompletionResponse, ToolCall } from '../types';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  /** logical tier -> model id, e.g. { fast: 'claude-haiku-4-5-20251001', balanced: 'claude-sonnet-5', deep: 'claude-opus-4-8' } */
  models?: { fast: string; balanced: string; deep: string };
  version?: string;
}

const DEFAULT_MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-5',
  deep: 'claude-opus-4-8',
};

/** Anthropic Messages API adapter (primary LLM provider per config, never hardcoded). */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private baseUrl: string;
  private models: { fast: string; balanced: string; deep: string };

  constructor(private config: AnthropicConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.models = config.models ?? DEFAULT_MODELS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.models[request.tier ?? 'balanced'];
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 1024,
      messages: this.toAnthropicMessages(request.messages),
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
          }
        : {}),
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': this.config.version ?? '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`anthropic completion failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    const text = data.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls: ToolCall[] = data.content
      .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));

    const stopMap: Record<string, CompletionResponse['stopReason']> = {
      end_turn: 'end',
      max_tokens: 'max_tokens',
      tool_use: 'tool_use',
      stop_sequence: 'stop_sequence',
    };

    return {
      text,
      toolCalls,
      stopReason: stopMap[data.stop_reason] ?? 'other',
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      servedBy: { provider: this.name, model: data.model ?? model },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models?limit=1`, {
        headers: { 'x-api-key': this.config.apiKey, 'anthropic-version': this.config.version ?? '2023-06-01' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Convert provider-agnostic messages into Anthropic's block format. */
  private toAnthropicMessages(messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue; // hoisted to top-level system param
      if (m.role === 'tool') {
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: unknown[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments || '{}') });
        }
        out.push({ role: 'assistant', content: blocks });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }
}
