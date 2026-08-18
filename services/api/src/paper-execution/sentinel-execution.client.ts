import { BadGatewayException, GatewayTimeoutException, Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * The api→sentinel hop for the execution loop.
 *
 * Deliberately a thin, separate client from `SentinelApiService` rather than a
 * method on it: that service is the trader-facing proxy (it enriches `/observe`
 * with the caller's own trades and positions, and dispatches notification
 * events from the response). None of that applies here — this call is for a
 * system account, its response is never rendered to a trader, and it must not
 * emit trader notifications. Sharing the class would mean threading a "but not
 * for this caller" flag through every one of those behaviours.
 *
 * What IS shared is the transport discipline, and for the same reason: a bare
 * `fetch` with no `AbortSignal` lets a hung Sentinel hold an API worker
 * indefinitely, and this client runs on a timer, so accumulating in-flight
 * calls would be a slow resource leak rather than a visible failure.
 */

export interface StrikeCandidateDto {
  role: 'ITM' | 'ATM' | 'OTM';
  strike: number;
  optionType: 'CE' | 'PE';
  premium: number | null;
  openInterest: number | null;
  volume: number | null;
  impliedVol: number | null;
  moneyness: number | null;
  tradable: boolean;
  selected: boolean;
  reason: string;
  checks: { id: string; label: string; passed: boolean; detail: string }[];
}

export interface ExecutionEvaluationDto {
  verdict: 'executable' | 'no-side-in-focus' | 'below-threshold' | 'no-option-chain' | 'no-tradable-strike';
  executable: boolean;
  reason: string;
  runId: string | null;
  symbol: string;
  observedAt: string;
  spot: number | null;
  sideInFocus: {
    side: 'CE' | 'PE';
    bias: 'bullish' | 'bearish';
    strike: number | null;
    confidence: number;
    rationale: string[];
    optionContext?: Record<string, unknown>;
  } | null;
  confidence: number;
  publication: Record<string, unknown> | null;
  strategyId: string | null;
  strategyName: string | null;
  strikes: {
    candidates: StrikeCandidateDto[];
    selected: StrikeCandidateDto | null;
    atmStrike: number | null;
    strikeStep: number | null;
    unavailableReason: string | null;
  };
  expiry: string | null;
  marketSnapshot: Record<string, unknown>;
}

@Injectable()
export class SentinelExecutionClient {
  private get baseUrl(): string {
    return (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
  }

  private get timeoutMs(): number {
    // Longer than the trader-facing 20 s ceiling: this call additionally reads
    // and evaluates the option chain, nothing is waiting on it interactively,
    // and the loop's own tick interval is far longer still.
    return Number(process.env.SENTINEL_EXECUTION_TIMEOUT_MS ?? 30_000);
  }

  async evaluate(input: {
    symbol: string;
    userId: string;
    strategyId?: string | null;
    minConfidence?: number;
  }): Promise<ExecutionEvaluationDto> {
    const token = process.env.SENTINEL_SERVICE_TOKEN ?? '';
    if (!token) {
      // Fail closed and say so. An unset token would otherwise surface as a
      // 401 from Sentinel, which reads like an auth bug rather than "this
      // deployment was never configured to run the execution loop".
      throw new ServiceUnavailableException('SENTINEL_SERVICE_TOKEN is not configured; the execution loop is disabled.');
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/execution/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': token },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GatewayTimeoutException(`Sentinel did not evaluate within ${this.timeoutMs}ms`);
      }
      throw new BadGatewayException(`Sentinel service unreachable: ${(err as Error).message}`);
    }

    if (res.status === 503) {
      // Sentinel's own market-data-unavailable signal. Propagated as-is so the
      // loop can treat "no market data" as a skip rather than a fault — the
      // distinction the 2026-08-17 outage fix exists to preserve.
      throw new ServiceUnavailableException(await res.text().catch(() => 'Sentinel has no market data'));
    }
    if (!res.ok) {
      throw new BadGatewayException(`Sentinel evaluate failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as ExecutionEvaluationDto;
  }
}
