import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { UniverseMarket } from '@tradew/market-data';
import { UniverseSyncService } from './universe-sync.service';

/**
 * Periodic universe refresh.
 *
 * Exchanges list and delist continuously — an IPO is tradable the morning it
 * lists, and a merged company stops existing overnight — so a catalogue built
 * once is wrong within a week. This keeps it current without anyone running a
 * command.
 *
 * OFF BY DEFAULT. `UNIVERSE_REFRESH_ENABLED=true` opts in. A background job
 * that downloads ~15 MiB and writes hundreds of thousands of rows should be an
 * operator's decision, not something that starts happening because a service
 * was deployed. The CLI (`npm run universe:sync`) covers the manual case and is
 * the only path that runs in development.
 *
 * A plain interval rather than @nestjs/schedule: this service does not depend
 * on that package today and one timer does not justify adding it. The interval
 * is unref'd so it can never hold the process open during a shutdown.
 *
 * SINGLE-FLIGHT. A refresh that overruns its interval must not start a second
 * copy of itself — two concurrent syncs would race on the same rows and double
 * the upstream cost. `inFlight` is that guard. This service is a singleton by
 * design (its package description says so), so a process-local guard is the
 * right scope; a second replica would need a database lease, which is why the
 * check logs loudly rather than silently skipping.
 */

/** Once a day is the natural cadence: the Indian master is republished daily. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Wait after boot before the first run, so startup is never blocked by a sync. */
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;

@Injectable()
export class UniverseRefreshScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UniverseRefreshScheduler.name);
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private inFlight = false;
  private readonly abort = new AbortController();

  constructor(private readonly sync: UniverseSyncService) {}

  onModuleInit(): void {
    if (process.env.UNIVERSE_REFRESH_ENABLED !== 'true') {
      this.logger.log('universe refresh disabled (set UNIVERSE_REFRESH_ENABLED=true to enable)');
      return;
    }

    const intervalMs = positiveInt(process.env.UNIVERSE_REFRESH_INTERVAL_MS) ?? DEFAULT_INTERVAL_MS;
    const initialDelayMs = positiveInt(process.env.UNIVERSE_REFRESH_INITIAL_DELAY_MS) ?? DEFAULT_INITIAL_DELAY_MS;

    this.logger.log(`universe refresh every ${Math.round(intervalMs / 60000)}min, first run in ${Math.round(initialDelayMs / 1000)}s`);

    this.initialTimer = setTimeout(() => {
      void this.run();
      this.timer = setInterval(() => void this.run(), intervalMs);
      this.timer.unref?.();
    }, initialDelayMs);
    this.initialTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.abort.abort();
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed so an operator endpoint or a test can trigger one run. */
  async run(): Promise<void> {
    if (this.inFlight) {
      this.logger.warn('previous universe refresh still running — skipping this tick');
      return;
    }
    this.inFlight = true;
    try {
      const report = await this.sync.sync({
        markets: configuredMarkets(),
        // Delisting is opt-in even here. It is the one irreversible-looking
        // operation in the sync, and an unattended job should not perform it
        // until an operator has watched a few runs and turned it on.
        delistMissing: process.env.UNIVERSE_REFRESH_DELIST === 'true',
        includeDerivatives: process.env.UNIVERSE_INCLUDE_DERIVATIVES === 'true',
        signal: this.abort.signal,
      });
      this.logger.log(
        `universe refresh done in ${Math.round(report.durationMs / 1000)}s: ` +
          `+${report.totals.created} ~${report.totals.updated} =${report.totals.unchanged} ` +
          `-${report.totals.delisted}` +
          (report.unavailable.length > 0 ? ` (unavailable: ${report.unavailable.map((u) => u.id).join(', ')})` : ''),
      );
    } catch (err) {
      // Never let a failed refresh kill the ingestion runtime: the live feed is
      // the service's primary job and a stale catalogue does not stop it.
      this.logger.error(`universe refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight = false;
    }
  }
}

/** `UNIVERSE_REFRESH_MARKETS=INDIA,CRYPTO` narrows the job; unset means all. */
function configuredMarkets(): UniverseMarket[] | undefined {
  const raw = process.env.UNIVERSE_REFRESH_MARKETS?.trim();
  if (!raw) return undefined;
  const valid = ['INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO'];
  const parsed = raw
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter((m) => valid.includes(m)) as UniverseMarket[];
  return parsed.length > 0 ? parsed : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
