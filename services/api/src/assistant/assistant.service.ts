import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * services/api side of the TradeW AI conversation brain — the ONLY caller of
 * the internal `services/tradew-ai` runtime (single public ingress,
 * ARCHITECTURE.md §1), exactly as `SentinelApiService` is for Sentinel.
 *
 * What this layer owns and the runtime deliberately does not:
 *   - who the user is (the runtime has no session concept and must not grow one)
 *   - whether they may ask (entitlement, enforced on the controller)
 *   - what gets recorded about the request (audit)
 *   - the shared service token on the hop
 *
 * ── DEGRADES, NEVER BREAKS ─────────────────────────────────────────────────
 *
 * The brain is the second half of a two-stage resolver: `apps/web` resolves
 * navigation and quotes with no network at all, and only asks here when it did
 * not understand. So an unreachable or unconfigured runtime must produce a
 * clean "I didn't understand that" rather than a 500 — a missing API key should
 * cost the user natural-language phrasing, not their workspace.
 */
@Injectable()
export class AssistantApiService {
  private readonly log = new Logger(AssistantApiService.name);

  private get baseUrl(): string {
    return (process.env.TRADEW_AI_SERVICE_URL ?? 'http://127.0.0.1:4020').replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      // Same shared secret as the api→sentinel hop. Sent unconditionally; the
      // runtime fails closed when it is unset or weak, so an empty value here
      // produces a clean 401 rather than an unguarded call.
      'x-service-token': process.env.SERVICE_TOKEN ?? '',
    };
  }

  /**
   * Ask the brain to turn an utterance into a plan.
   *
   * `userId` is passed for the runtime's telemetry only — it is not a
   * credential there and confers nothing. Authorization happened before this
   * method was called.
   */
  async interpret(userId: string, utterance: string, context?: Record<string, unknown>) {
    let res: Response;
    try {
      const controller = new AbortController();
      // A model call that has not answered in 30s is not going to be useful to
      // someone waiting on a text box.
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        res = await fetch(`${this.baseUrl}/assistant/interpret`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ utterance, context, userId }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.log.warn(`tradew-ai unreachable: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException('assistant is unavailable');
    }

    if (res.status === 503) {
      // The runtime is up but has no provider configured — a supported state.
      throw new ServiceUnavailableException('assistant is not configured');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn(`tradew-ai returned ${res.status}: ${body.slice(0, 200)}`);
      throw new BadGatewayException('assistant returned an error');
    }

    return (await res.json()) as {
      goal: string;
      steps: { describe: string; action: Record<string, unknown> }[];
      needsAnalysis: boolean;
      unsupported: string | null;
      dropped: number;
    };
  }
}
