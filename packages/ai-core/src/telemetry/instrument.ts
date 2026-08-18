import type { LlmProvider } from '../providers/interfaces';
import type { CompletionRequest, CompletionResponse } from '../providers/types';
import { currentTelemetryContext, emitAiCall } from './bus';

/**
 * Per-million-token rates, USD. Keyed by a substring of the model id so a
 * point release (`claude-sonnet-5-20260501`) matches without a table edit.
 *
 * This is an ESTIMATE and is labelled as one everywhere it surfaces. It exists
 * so an operator can see that one agent is burning 40x what the others do —
 * a question the provider's own billing console answers accurately but a month
 * late and without per-agent attribution. Longest key wins, so a specific
 * entry can override a general one.
 */
const RATE_CARD: Array<{ match: string; inPerM: number; outPerM: number }> = [
  { match: 'claude-opus', inPerM: 15, outPerM: 75 },
  { match: 'claude-sonnet', inPerM: 3, outPerM: 15 },
  { match: 'claude-haiku', inPerM: 0.8, outPerM: 4 },
  { match: 'gpt-4o-mini', inPerM: 0.15, outPerM: 0.6 },
  { match: 'gpt-4o', inPerM: 2.5, outPerM: 10 },
  { match: 'gpt-4', inPerM: 30, outPerM: 60 },
  // Self-hosted. Zero is the honest number for marginal cost per token; the
  // GPU bill is real but it is not attributable per call.
  { match: 'llama', inPerM: 0, outPerM: 0 },
  { match: 'mistral', inPerM: 0, outPerM: 0 },
  { match: 'qwen', inPerM: 0, outPerM: 0 },
];

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const id = model.toLowerCase();
  const rate = RATE_CARD.filter((r) => id.includes(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
  if (!rate) return 0;
  return (promptTokens / 1_000_000) * rate.inPerM + (completionTokens / 1_000_000) * rate.outPerM;
}

/**
 * Wrap an LlmProvider so every `complete()` reports itself.
 *
 * Applied once, in `createProviderManager`, rather than at each call site. That
 * placement is the whole design: instrumenting the factory means a new agent,
 * a new service, or a call added in a hotfix is captured automatically. Asking
 * developers to remember to log would guarantee the admin portal shows a
 * confident, incomplete picture — worse than no picture, because an operator
 * would trust it.
 *
 * Attribution (`system`, `agent`) comes from the ambient telemetry context, so
 * calls made inside `trackAgent`/`runAgentRun` are attributed for free.
 * `defaults` covers the rest.
 */
export function instrumentLlmProvider(
  provider: LlmProvider,
  defaults: { system?: string; agent?: string } = {},
): LlmProvider {
  return {
    get name() {
      return provider.name;
    },
    healthCheck: () => provider.healthCheck(),
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const ctx = currentTelemetryContext();
      const startedAt = Date.now();
      try {
        const response = await provider.complete(request);
        const promptTokens = response.usage?.inputTokens ?? 0;
        const completionTokens = response.usage?.outputTokens ?? 0;
        const model = response.servedBy?.model ?? request.model ?? 'unknown';
        emitAiCall({
          system: defaults.system ?? ctx.system ?? 'unknown',
          agent: defaults.agent ?? 'unattributed',
          provider: response.servedBy?.provider ?? provider.name,
          model,
          tier: request.tier,
          promptTokens,
          completionTokens,
          costUsd: estimateCostUsd(model, promptTokens, completionTokens),
          latencyMs: Date.now() - startedAt,
          // A truncated completion is not a failure but it is not a clean
          // success either — the caller got a partial answer. Distinguished so
          // an operator can spot a maxTokens budget that is set too low.
          status: response.stopReason === 'max_tokens' ? 'fallback' : 'ok',
        });
        return response;
      } catch (err) {
        emitAiCall({
          system: defaults.system ?? ctx.system ?? 'unknown',
          agent: defaults.agent ?? 'unattributed',
          provider: provider.name,
          model: request.model ?? 'unknown',
          tier: request.tier,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - startedAt,
          status: isTimeout(err) ? 'timeout' : 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        // Rethrown unchanged. Telemetry observes, it does not intervene — the
        // provider manager's own fallback logic must see the original error.
        throw err;
      }
    },
  };
}

function isTimeout(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ETIMEDOUT|AbortError/i.test(message);
}
