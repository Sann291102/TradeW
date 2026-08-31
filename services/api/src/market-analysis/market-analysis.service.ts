import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { classifySymbol, type SymbolCoverage } from './symbol-coverage';

/**
 * services/api side of the canonical market-observation read — the ONLY caller
 * of Sentinel's `/market-observation` route (single public ingress,
 * ARCHITECTURE.md §1), exactly as `SentinelApiService` is for `/observe`.
 *
 * ── WHY THIS IS NOT ENTITLEMENT-GATED, AND WHY THAT IS SAFE ────────────────
 *
 * The neighbouring Sentinel routes require the `sentinel` capability because
 * they return Sentinel's CONCLUSION — `synthesis`, the publication gate's
 * verdict, `sideInFocus`, `strategyAdvice`. That is the premium product.
 *
 * This route returns MEASUREMENTS: the same VWAP, RSI, EMA, structure and
 * option-chain aggregates a user can compute from the candles already on their
 * screen. Charging for arithmetic the chart performs for free would not protect
 * the premium product; it would only make the assistant useless while the
 * numbers stayed visible two centimetres away.
 *
 * The boundary is enforced by SHAPE, not by trust: Sentinel's projection type
 * has no field a verdict can travel in, and `assertNoPremiumFields` below
 * re-checks the wire payload on this side. Two independent checks, the same
 * posture `brain.ts` takes toward the model's output — if they ever disagree,
 * the stricter one is right and the other is the bug.
 *
 * ── DEGRADES, NEVER FABRICATES ─────────────────────────────────────────────
 *
 * An unreachable Sentinel produces a 503 the assistant reads back verbatim. It
 * never produces a partial observation with plausible numbers in it.
 */

/**
 * Keys that must never appear at the top level of an observation payload.
 *
 * Mirrors `FORBIDDEN_OBSERVATION_FIELDS` in
 * `services/sentinel/src/intelligence/market-observation.ts`. Duplicated
 * deliberately — this is the second half of a two-sided check, and a shared
 * constant imported from the service being checked would make both sides fail
 * together.
 */
const PREMIUM_FIELDS = [
  'synthesis',
  'publication',
  'sideInFocus',
  'strategyAdvice',
  'strategyAdvices',
  'strategyMatches',
  'strategyLifecycles',
  'crossValidation',
  'confidence',
  'institutionalCrossValidation',
  'recommendation',
  'signals',
] as const;

export interface MarketAnalysisResult {
  ok: boolean;
  coverage: SymbolCoverage;
  /** The canonical projection, when `ok`. Shape owned by services/sentinel. */
  observation?: Record<string, unknown>;
  /** Why there is no observation. Written to be shown to a user. */
  reason?: string;
}

@Injectable()
export class MarketAnalysisApiService {
  private readonly log = new Logger(MarketAnalysisApiService.name);

  private get baseUrl(): string {
    return (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-service-token': process.env.SENTINEL_SERVICE_TOKEN ?? '',
    };
  }

  /**
   * Read one symbol on one timeframe.
   *
   * Coverage is classified BEFORE the fetch, so a crypto symbol never reaches
   * the NSE engine at all — the refusal is a fact about the data path, not a
   * failed request that happened to error.
   */
  async analyse(input: {
    symbol: string;
    timeframe: string;
    includeContracts?: boolean;
  }): Promise<MarketAnalysisResult> {
    const coverage = classifySymbol(input.symbol);

    if (!coverage.analysable) {
      return { ok: false, coverage, reason: coverage.reason ?? 'This symbol has no canonical analysis path.' };
    }

    const payload = await this.post('/market-observation', {
      symbol: coverage.symbol,
      timeframe: input.timeframe,
      includeContracts: input.includeContracts === true,
    });

    // Sentinel answers `{ ok: false, reason }` for a timeframe it cannot read.
    // That is an answer, not a fault, and it reaches the user as written.
    if (!payload || payload.ok !== true || !payload.observation) {
      return {
        ok: false,
        coverage,
        reason:
          typeof payload?.reason === 'string'
            ? payload.reason
            : 'The analysis engine returned no observation for this request.',
      };
    }

    const observation = payload.observation as Record<string, unknown>;
    assertNoPremiumFields(observation);

    return { ok: true, coverage, observation };
  }

  private async post(path: string, body: unknown): Promise<{ ok?: boolean; reason?: string; observation?: unknown } | null> {
    let res: Response;
    try {
      const controller = new AbortController();
      // One snapshot and a projection. Anything past 20s is a fault, not a
      // slow read, and the person waiting on a text box has already given up.
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.log.warn(`sentinel unreachable: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException('the analysis engine is unavailable');
    }

    if (res.status === 503) {
      // No real market data for this symbol. Sentinel's own message names which
      // source failed and why; it is far more useful than anything this layer
      // could compose, so it is passed through.
      const detail = await res.text().catch(() => '');
      throw new ServiceUnavailableException(extractMessage(detail) ?? 'no real market data is available for this symbol');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.log.warn(`sentinel returned ${res.status}: ${detail.slice(0, 200)}`);
      throw new BadGatewayException('the analysis engine returned an error');
    }

    return (await res.json()) as { ok?: boolean; reason?: string; observation?: unknown };
  }
}

/**
 * Strip-and-shout: a premium field on this route is a BUG in Sentinel's
 * projection, and shipping it to a free surface silently would be the leak the
 * whole boundary exists to prevent.
 *
 * Deletes rather than throws. A 500 here would take out the assistant's ability
 * to report a price because someone added a field upstream; deleting keeps the
 * measurements flowing while the log makes the mistake loud.
 */
export function assertNoPremiumFields(observation: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PREMIUM_FIELDS) {
    if (key in observation) {
      found.push(key);
      delete observation[key];
    }
  }
  if (found.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[market-analysis] premium field(s) present in an observation payload and removed: ${found.join(', ')}. ` +
        'This is a defect in services/sentinel/src/intelligence/market-observation.ts.',
    );
  }
  return found;
}

/** Pull Nest's `message` out of an error body, when there is one. */
function extractMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    return null;
  }
}
