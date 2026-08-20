import { BadGatewayException, GatewayTimeoutException, Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * The api→sentinel hop for a historical replay.
 *
 * A separate thin client from `SentinelExecutionClient` for the same reason
 * that one is separate from `SentinelApiService`: nothing about its behaviour
 * transfers. This call is not on a timer, it is not for a system account, its
 * response is a whole window rather than one decision, and its timeout has to
 * be minutes rather than seconds because it walks thousands of bars. Sharing a
 * class would mean threading "but not for this caller" through every one of
 * those.
 *
 * The transport discipline IS shared, and deliberately: a bare `fetch` with no
 * `AbortSignal` lets a hung Sentinel hold an API worker forever, and the run
 * queue would then stall behind it with no visible failure.
 */

export interface ScanBarDto {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi?: number;
}

export interface ScanSignalDto {
  barIndex: number;
  nextBarIndex: number | null;
  at: string;
  strategyId: string;
  strategyName: string;
  strategyVersion: string;
  confidence: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  validated: boolean;
  rulesMatched: string[];
  rulesUnmet: string[];
  invalidationsTriggered: string[];
  context: Record<string, unknown>;
}

export interface ScanCoverageDto {
  requestedFrom: string;
  requestedTo: string;
  firstBarAt: string | null;
  lastBarAt: string | null;
  barCount: number;
  sessionCount: number;
  source: string | null;
  dataVersion: string | null;
  missingSessions: string[];
  intraSessionGaps: { after: string; before: string; missingBars: number }[];
  empty: boolean;
}

export interface BacktestScanDto {
  symbol: string;
  exchange: string;
  instrumentId: string | null;
  instrumentType: string | null;
  lotSize: number;
  timeframe: string;
  coverage: ScanCoverageDto;
  bars: ScanBarDto[];
  signals: ScanSignalDto[];
  strategyVersion: string;
  strategiesConsidered: { id: string; name: string; version: string }[];
  warmupBars: number;
  scanVersion: string;
}

/** Raised when Sentinel refused the request itself (bad symbol, bad window). */
export class BacktestScanRejected extends Error {}

@Injectable()
export class SentinelBacktestClient {
  private get baseUrl(): string {
    return (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
  }

  private get timeoutMs(): number {
    // Minutes, not seconds: a replay walks every bar in the window through the
    // full strategy engine. Nothing is waiting on it interactively — the caller
    // is a background runner and the user is watching a status, not a spinner.
    return Number(process.env.BACKTEST_SCAN_TIMEOUT_MS ?? 300_000);
  }

  async scan(input: {
    symbol: string;
    timeframe: string;
    startAt: string;
    endAt: string;
    strategyId: string | null;
    minConfidence: number;
    includeUnvalidated: boolean;
  }): Promise<BacktestScanDto> {
    const token = process.env.SENTINEL_SERVICE_TOKEN ?? '';
    if (!token) {
      // Fail closed and name the cause. An unset token would otherwise surface
      // as a 401, which reads like an auth bug rather than "this deployment was
      // never configured to reach Sentinel".
      throw new ServiceUnavailableException(
        'SENTINEL_SERVICE_TOKEN is not configured; backtesting cannot reach the strategy engine.',
      );
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/backtest/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': token },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GatewayTimeoutException(`Sentinel did not complete the replay within ${this.timeoutMs}ms`);
      }
      throw new BadGatewayException(`Sentinel service unreachable: ${(err as Error).message}`);
    }

    if (res.status === 400) {
      // Sentinel rejected the request itself — an unknown symbol, an
      // unsupported timeframe, a window too large. That is the USER's error and
      // must reach them as their own words, not as "the backtest crashed".
      throw new BacktestScanRejected(await res.text().catch(() => 'Sentinel rejected the request'));
    }
    if (res.status === 503) {
      throw new ServiceUnavailableException(await res.text().catch(() => 'Sentinel has no market data'));
    }
    if (!res.ok) {
      throw new BadGatewayException(`Sentinel replay failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as BacktestScanDto;
  }
}
