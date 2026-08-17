import { LlmProvider } from '../interfaces';
import { ChatMessage, CompletionRequest, CompletionResponse, ToolCall } from '../types';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  /** logical tier -> model id, e.g. { fast: 'claude-haiku-4-5-20251001', balanced: 'claude-sonnet-5', deep: 'claude-opus-4-8' } */
  models?: { fast: string; balanced: string; deep: string };
  version?: string;
  /**
   * Ceiling on one completion. Defaults to `DEFAULT_TIMEOUT_MS`.
   *
   * ── WHY A DEFAULT AND NOT AN OPTION ───────────────────────────────────────
   *
   * There was no timeout here at all, and this is the FIRST provider in
   * `AI_LLM_ORDER`, so it is the one actually selected in production.
   *
   * A missing timeout is not "slower in the worst case" — it defeats the
   * fallback that exists to make this provider optional. Every caller in Sentinel
   * wraps its LLM use in `try/catch` and composes a deterministic draft when the
   * model fails (see `SentinelOrchestratorService.polish`). That safety net
   * catches ERRORS. A hung socket is not an error: it never settles, so the
   * catch never runs, and `/observe` waits behind it indefinitely. The one
   * failure mode the fallback was built for was the one it could not handle.
   *
   * Measured 2026-08-17: `/sentinel/observe` p50 2,178 ms, p95 7,703 ms, max
   * **54,984 ms** — a single observation held for 55 seconds. Nothing in the
   * chain enforced a ceiling: neither this provider, nor the api→sentinel hop,
   * nor the browser→api hop. Under concurrency that is how a slow provider
   * becomes an outage, because each hung request holds a worker and a socket at
   * every tier at once.
   *
   * The default is deliberately generous against observed latency but far below
   * any caller's patience, so the deterministic draft is reached while the user
   * is still waiting rather than after they have given up.
   */
  timeoutMs?: number;
}

const DEFAULT_MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-5',
  deep: 'claude-opus-4-8',
};

/** See `AnthropicConfig.timeoutMs` for why this is not optional in practice. */
const DEFAULT_TIMEOUT_MS = 30_000;

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

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': this.config.version ?? '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Converted to a thrown Error on purpose, matching the sibling
      // openai-compatible provider: callers fall back on a REJECTION, so a
      // timeout has to become one for the deterministic draft to be reached.
      if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
        throw new Error(`anthropic completion timed out after ${timeoutMs}ms (model ${model})`);
      }
      throw err;
    }
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
