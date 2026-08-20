import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isTradingDay, nonTradingReason } from '../discipline/market-calendar';
import { evaluateHealth, type DependencyHealth, type LabHealth } from './lab-health';

/**
 * The probes behind the Lab's health gate.
 *
 * Every check here answers with what it OBSERVED, never with a composed
 * diagnosis. That distinction is not stylistic: on 2026-08-17 a hardcoded
 * market-data error message named two innocent components and hid the real one,
 * so the investigation started in the wrong service. `CandleMarketDataProvider`
 * was rewritten to carry the upstream's own words, and this follows it — a
 * probe reports the status line it got, or the exception message, and nothing
 * else.
 *
 * ## The session is read from the calendar, not from a clock comparison
 *
 * `isTradingDay` and `nonTradingReason` come from the shared NSE calendar with
 * its holiday list. A hand-rolled `hours >= 9` check would trade on Republic
 * Day, and the brief asks explicitly that the session not be hardcoded.
 */

/** IST minute-of-day the NSE equity session opens and closes. */
const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

/** Dependencies without which the Lab may not observe at all. */
const REQUIRED = ['database', 'sentinel', 'market-data'];

@Injectable()
export class LabHealthService {
  private readonly logger = new Logger(LabHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get enabled(): boolean {
    // Mirrors `PAPER_EXECUTION_ENABLED`: explicit opt-in, defaulting to off, so
    // a deployment that pulls this code and happens to have a lab profile row
    // cannot silently start observing.
    return (process.env.AGENT_LAB_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  private get maxBarAgeSeconds(): number {
    return Number(process.env.AGENT_LAB_MAX_BAR_AGE_SEC ?? 900);
  }

  async check(symbols: string[]): Promise<LabHealth> {
    const checkedAt = new Date();
    const dependencies = await Promise.all([
      this.probeDatabase(),
      this.probeSentinel(),
      this.probeMarketData(symbols, checkedAt),
    ]);

    return evaluateHealth({
      enabled: this.enabled,
      dependencies,
      session: this.session(checkedAt),
      // Indian equities only, for now. When a `MarketAdapter` exists this comes
      // from the adapter — a 24/7 crypto market genuinely observes outside any
      // session, and that is a property of the market, not of the Lab.
      observeOutsideSession: false,
      requiredDependencies: REQUIRED,
      checkedAt,
    });
  }

  /** The market session, from the shared NSE calendar. */
  session(at: Date): { open: boolean; reason: string } {
    const nonTrading = nonTradingReason(at);
    if (nonTrading) return { open: false, reason: `closed:${nonTrading}` };
    if (!isTradingDay(at)) return { open: false, reason: 'closed:non-trading-day' };

    const ist = new Date(at.getTime() + 5.5 * 3_600_000);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (minute < SESSION_OPEN_MINUTE) return { open: false, reason: 'closed:pre-open' };
    if (minute >= SESSION_CLOSE_MINUTE) return { open: false, reason: 'closed:after-hours' };
    return { open: true, reason: 'open' };
  }

  private async probeDatabase(): Promise<DependencyHealth> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { name: 'database', status: 'ok', detail: 'reachable', latencyMs: Date.now() - started };
    } catch (err) {
      return {
        name: 'database',
        status: 'unavailable',
        detail: (err as Error).message,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async probeSentinel(): Promise<DependencyHealth> {
    const base = (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
    const started = Date.now();
    try {
      // A bare fetch with no signal would let a hung Sentinel hold this probe —
      // and therefore the whole tick — indefinitely. The same discipline the
      // execution client applies.
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { name: 'sentinel', status: 'unavailable', detail: `HTTP ${res.status}`, latencyMs };
      }
      return { name: 'sentinel', status: 'ok', detail: 'reachable', latencyMs };
    } catch (err) {
      const name = (err as Error)?.name;
      return {
        name: 'sentinel',
        status: 'unavailable',
        detail: name === 'TimeoutError' ? 'did not respond within 5000ms' : (err as Error).message,
        latencyMs: Date.now() - started,
      };
    }
  }

  /**
   * Market-data health, judged against the session rather than against the
   * clock alone.
   *
   * Outside the session the newest bar is always old — that is the exchange
   * being shut, not a fault, and reporting it as degraded would leave the Lab
   * in a permanent alarm state every evening and every weekend. Bar age is only
   * evidence of a problem while the market is actually trading.
   */
  private async probeMarketData(symbols: string[], at: Date): Promise<DependencyHealth> {
    if (symbols.length === 0) {
      return { name: 'market-data', status: 'ok', detail: 'no lab profile is observing any symbol' };
    }
    try {
      const newest = await this.prisma.candle.findFirst({
        where: { instrument: { symbol: { in: symbols } } },
        orderBy: { bucketStart: 'desc' },
        select: { bucketStart: true, timeframe: true, instrument: { select: { symbol: true } } },
      });
      if (!newest) {
        return {
          name: 'market-data',
          status: 'unavailable',
          detail: `no stored bars for ${symbols.join(', ')}`,
        };
      }

      const ageSeconds = Math.round((at.getTime() - newest.bucketStart.getTime()) / 1000);
      const sessionOpen = this.session(at).open;
      const label = `newest bar ${newest.instrument.symbol} ${newest.timeframe} at ${newest.bucketStart.toISOString()} (${ageSeconds}s old)`;

      if (sessionOpen && ageSeconds > this.maxBarAgeSeconds) {
        return {
          name: 'market-data',
          status: 'degraded',
          detail: `${label} — beyond the ${this.maxBarAgeSeconds}s limit during an open session`,
        };
      }
      return { name: 'market-data', status: 'ok', detail: label };
    } catch (err) {
      return { name: 'market-data', status: 'unavailable', detail: (err as Error).message };
    }
  }
}
