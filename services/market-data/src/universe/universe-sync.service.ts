import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createCatalogueSources,
  dedupe,
  describeAvailability,
  normalise,
  type CatalogueSource,
  type NormalisedRecord,
  type UniverseMarket,
} from '@tradew/market-data';
import { PrismaService } from '../prisma.service';

/**
 * Builds and refreshes `UniverseInstrument` from the provider catalogues.
 *
 * This is the write side of the tradable universe. It runs in the ingestion
 * service, never in `services/api` — the API is a read path (ARCHITECTURE.md
 * §1), and a sync that downloads a 10 MiB master and writes 200k rows has no
 * business happening inside a request.
 *
 * THREE RULES THE IMPLEMENTATION IS SHAPED AROUND
 *
 * 1. NOTHING IS DELETED. An instrument that leaves a provider's catalogue is
 *    marked DELISTED with a timestamp and keeps every field it had. Charts,
 *    backtests and journal entries refer to instruments years after they stop
 *    trading, and a delisted row is the only thing that lets those still render
 *    a name instead of a bare ticker.
 *
 * 2. DELISTING REQUIRES PROOF, and only one kind of run provides it: a run that
 *    COMPLETED, covered a whole market, and was not truncated by a limit. A run
 *    that crashed on page 40, or was capped for a smoke test, or used a source
 *    that could not authenticate, has said nothing at all about what the
 *    provider still lists. Every one of those cases is checked before a single
 *    row is deactivated, because the failure mode — delisting an entire market
 *    because an API key expired — is silent, plausible and catastrophic.
 *
 * 3. RE-RUNS ARE CHEAP. Rows that have not changed are touched only on
 *    `lastSeenAt`, in bulk, rather than being rewritten. A daily sync over a
 *    stable catalogue should be almost entirely `unchanged`, and if it is not,
 *    that is a finding.
 */

/** How many rows go into one write transaction. */
const WRITE_BATCH = 500;

/** Fields compared to decide whether a row actually changed. */
const TRACKED_FIELDS = [
  'displayName',
  'assetClass',
  'status',
  'quoteCurrency',
  'accountCurrency',
  'requiresFxConversion',
  'country',
  'isin',
  'figi',
  'cusip',
  'sedol',
  'mic',
  'provider',
  'providerSymbol',
  'securityId',
  'exchangeSegment',
  'series',
  'baseAsset',
  'quoteAsset',
  'lotSize',
  'searchText',
] as const;

export interface UniverseSyncOptions {
  /** Restrict to these markets. Omit for all five. */
  markets?: UniverseMarket[];
  /** Parse and report without writing. */
  dryRun?: boolean;
  /**
   * Cap records per source. Marks the run `truncated`, which permanently
   * disqualifies it from delisting anything.
   */
  limit?: number;
  /**
   * Mark instruments the providers no longer list as DELISTED. Off by default:
   * it is the one destructive-ish operation here and should be a deliberate act.
   */
  delistMissing?: boolean;
  /** Include Indian F&O and currency-derivative segments (~120k contracts). */
  includeDerivatives?: boolean;
  sources?: CatalogueSource[];
  signal?: AbortSignal;
}

export interface UniverseSyncSourceReport {
  source: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  markets: UniverseMarket[];
  discovered: number;
  pages: number;
  created: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  rejected: number;
  delisted: number;
  truncated: boolean;
  errors: string[];
  durationMs: number;
  runId?: string;
}

export interface UniverseSyncReport {
  dryRun: boolean;
  markets: UniverseMarket[];
  sources: UniverseSyncSourceReport[];
  /** Sources that could not run at all, and why. */
  unavailable: Array<{ id: string; reason: string }>;
  totals: { discovered: number; created: number; updated: number; unchanged: number; delisted: number };
  durationMs: number;
}

@Injectable()
export class UniverseSyncService {
  private readonly logger = new Logger(UniverseSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(options: UniverseSyncOptions = {}): Promise<UniverseSyncReport> {
    const startedAt = Date.now();
    const markets = options.markets ?? (['INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO'] as UniverseMarket[]);
    const sources =
      options.sources ??
      createCatalogueSources({ dhan: { includeDerivatives: options.includeDerivatives } });

    const report: UniverseSyncReport = {
      dryRun: options.dryRun ?? false,
      markets,
      sources: [],
      unavailable: [],
      totals: { discovered: 0, created: 0, updated: 0, unchanged: 0, delisted: 0 },
      durationMs: 0,
    };

    for (const availability of describeAvailability(sources)) {
      if (!availability.configured) {
        report.unavailable.push({ id: availability.id, reason: availability.reason ?? 'not configured' });
      }
    }

    for (const source of sources) {
      const covered = source.markets.filter((m) => markets.includes(m));
      if (covered.length === 0) continue;

      if (!source.isConfigured()) {
        // Skipped, not run-and-empty. The distinction is the whole of rule 2.
        this.logger.warn(`source ${source.id} is not configured — skipping ${covered.join(', ')}`);
        report.sources.push(emptyReport(source.id, 'SKIPPED', covered));
        continue;
      }

      const sourceReport = await this.syncSource(source, covered, options);
      report.sources.push(sourceReport);
      report.totals.discovered += sourceReport.discovered;
      report.totals.created += sourceReport.created;
      report.totals.updated += sourceReport.updated;
      report.totals.unchanged += sourceReport.unchanged;
      report.totals.delisted += sourceReport.delisted;
    }

    report.durationMs = Date.now() - startedAt;
    return report;
  }

  private async syncSource(
    source: CatalogueSource,
    markets: UniverseMarket[],
    options: UniverseSyncOptions,
  ): Promise<UniverseSyncSourceReport> {
    const startedAt = Date.now();
    const result: UniverseSyncSourceReport = {
      source: source.id,
      status: 'COMPLETED',
      markets,
      discovered: 0,
      pages: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      duplicates: 0,
      rejected: 0,
      delisted: 0,
      truncated: Boolean(options.limit),
      errors: [],
      durationMs: 0,
    };

    const run = options.dryRun ? null : await this.openRun(source.id, markets);
    result.runId = run?.id;

    // Refs seen this run, per market. Needed for delisting and small enough to
    // hold: a ref is ~24 bytes and the largest single market is ~200k rows.
    const seenByMarket = new Map<UniverseMarket, Set<string>>(markets.map((m) => [m, new Set<string>()]));

    try {
      for await (const page of source.pages({ markets, limit: options.limit, signal: options.signal })) {
        result.pages++;
        result.rejected += page.rejected.length;
        if (page.rejected.length > 0) {
          this.logger.warn(`${source.id}/${page.label}: ${page.rejected.length} rejected; first: ${page.rejected[0].reason}`);
        }

        const normalised = page.records.map(normalise);
        const { records, duplicates } = dedupe(normalised);
        result.discovered += page.records.length;
        result.duplicates += duplicates;

        for (const record of records) seenByMarket.get(record.market)?.add(record.ref);

        if (!options.dryRun) {
          const written = await this.writeBatch(records);
          result.created += written.created;
          result.updated += written.updated;
          result.unchanged += written.unchanged;
        }

        this.logger.log(
          `${source.id}/${page.label}: ${records.length} records ` +
            `(+${result.created} ~${result.updated} =${result.unchanged})`,
        );
      }
    } catch (err) {
      // A source that dies mid-stream has still contributed every page it
      // yielded — those are real and are kept. What it loses is the right to
      // delist anything, which PARTIAL encodes.
      const message = err instanceof Error ? err.message : String(err);
      result.status = 'PARTIAL';
      result.errors.push(message);
      this.logger.error(`${source.id} failed after ${result.pages} page(s): ${message}`);
      if (result.pages === 0) result.status = 'FAILED';
    }

    if (this.mayDelist(result, options)) {
      for (const market of markets) {
        result.delisted += await this.delistMissing(source.id, market, seenByMarket.get(market) ?? new Set());
      }
    }

    result.durationMs = Date.now() - startedAt;
    if (run) await this.closeRun(run.id, result);
    return result;
  }

  /**
   * Whether this run has earned the right to mark rows DELISTED.
   *
   * Every clause is a real failure that has to be excluded, not defensive
   * boilerplate: a truncated run saw only the first N records; a PARTIAL run
   * stopped early; a run that produced no pages at all saw nothing. Any of them
   * treated as authoritative would delist most of a market.
   */
  private mayDelist(result: UniverseSyncSourceReport, options: UniverseSyncOptions): boolean {
    if (!options.delistMissing || options.dryRun) return false;
    if (result.truncated) return false;
    if (result.status !== 'COMPLETED') return false;
    if (result.pages === 0 || result.discovered === 0) return false;
    return true;
  }

  /**
   * Write one page.
   *
   * Existing rows are read in one query keyed by `ref`, compared in memory, and
   * only the genuinely-changed ones are written. Rows that match are collapsed
   * into a single `updateMany` that touches `lastSeenAt` alone — which is what
   * keeps a daily re-sync of a stable 200k-row catalogue to a handful of
   * statements instead of 200k updates.
   */
  private async writeBatch(records: NormalisedRecord[]): Promise<{ created: number; updated: number; unchanged: number }> {
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (let i = 0; i < records.length; i += WRITE_BATCH) {
      const slice = records.slice(i, i + WRITE_BATCH);
      const refs = slice.map((r) => r.ref);
      const existing = await this.prisma.universeInstrument.findMany({ where: { ref: { in: refs } } });
      const byRef = new Map(existing.map((row) => [row.ref, row]));

      const now = new Date();
      const untouched: string[] = [];
      const writes: Prisma.PrismaPromise<unknown>[] = [];

      for (const record of slice) {
        const row = byRef.get(record.ref);
        const data = this.toColumns(record, now);

        if (!row) {
          // `upsert`, not `create`. De-duplication is per-page, but a source can
          // legitimately emit the same instrument on two DIFFERENT pages —
          // Twelve Data's /stocks and /etf feeds overlap on some lines, and each
          // is its own page. A bare create would then violate the `ref` unique
          // constraint and fail the whole slice's transaction. Upserting makes a
          // cross-page repeat land as an update instead of an outage.
          writes.push(
            this.prisma.universeInstrument.upsert({
              where: { ref: record.ref },
              create: { ...data, firstSeenAt: now, lastSeenAt: now },
              update: { ...data, lastSeenAt: now },
            }),
          );
          created++;
          continue;
        }

        if (this.hasChanged(row as unknown as Record<string, unknown>, record)) {
          writes.push(
            this.prisma.universeInstrument.update({
              where: { id: row.id },
              data: {
                ...data,
                lastSeenAt: now,
                // Coming back into a provider's catalogue clears the delisting.
                // A re-listed instrument is a real event (it happens after a
                // corporate action or a suspension) and leaving the timestamp
                // would leave the row permanently marked as gone.
                delistedAt: record.status === 'DELISTED' ? (row.delistedAt ?? now) : null,
              },
            }),
          );
          updated++;
        } else {
          untouched.push(row.id);
          unchanged++;
        }
      }

      if (untouched.length > 0) {
        writes.push(
          this.prisma.universeInstrument.updateMany({
            where: { id: { in: untouched } },
            data: { lastSeenAt: now },
          }),
        );
      }

      // One transaction per slice: a page either lands or does not, and a
      // crash never leaves half a page written with the other half missing.
      if (writes.length > 0) await this.prisma.$transaction(writes);
    }

    return { created, updated, unchanged };
  }

  private toColumns(record: NormalisedRecord, now: Date) {
    return {
      market: record.market,
      exchange: record.exchange,
      mic: record.mic ?? null,
      symbol: record.symbol,
      ref: record.ref,
      displayName: record.displayName,
      assetClass: record.assetClass,
      status: record.status,
      country: record.country ?? null,
      quoteCurrency: record.quoteCurrency,
      accountCurrency: record.accountCurrency,
      requiresFxConversion: record.requiresFxConversion,
      isin: record.isin ?? null,
      figi: record.figi ?? null,
      cusip: record.cusip ?? null,
      sedol: record.sedol ?? null,
      provider: record.provider,
      providerSymbol: record.providerSymbol,
      securityId: record.securityId ?? null,
      exchangeSegment: record.exchangeSegment ?? null,
      series: record.series ?? null,
      baseAsset: record.baseAsset ?? null,
      quoteAsset: record.quoteAsset ?? null,
      lotSize: record.lotSize ?? null,
      tickSize: record.tickSize !== undefined ? new Prisma.Decimal(record.tickSize) : null,
      minQty: record.minQty !== undefined ? new Prisma.Decimal(record.minQty) : null,
      stepSize: record.stepSize !== undefined ? new Prisma.Decimal(record.stepSize) : null,
      searchText: record.searchText,
      raw: (record.raw ?? null) as Prisma.InputJsonValue,
      delistedAt: record.status === 'DELISTED' ? now : null,
    } satisfies Prisma.UniverseInstrumentUncheckedCreateInput;
  }

  /**
   * Compare only the fields whose change is meaningful.
   *
   * `raw` is excluded on purpose: providers reorder keys and add fields
   * routinely, so comparing it would report every row as changed on every run
   * and defeat the incremental write entirely. The decimal columns are excluded
   * for a related reason — they arrive as strings, and a string/Decimal
   * comparison is a false positive on every row.
   */
  private hasChanged(row: Record<string, unknown>, record: NormalisedRecord): boolean {
    for (const field of TRACKED_FIELDS) {
      const next = (record as unknown as Record<string, unknown>)[field] ?? null;
      const current = row[field] ?? null;
      if (current !== next) return true;
    }
    return false;
  }

  /**
   * Mark everything this source owns in this market, that the run did not see,
   * as DELISTED.
   *
   * Scoped by `provider` so one source's completed run can never delist another
   * source's rows — a full Binance sync says nothing about the LSE.
   *
   * The refuse-to-run guard below is the last line of defence behind
   * `mayDelist`: if a "complete" run somehow saw nothing, that is a bug in this
   * service or an upstream returning an empty body with a 200, and wiping the
   * market is the worst possible response to either.
   */
  private async delistMissing(provider: string, market: UniverseMarket, seen: Set<string>): Promise<number> {
    if (seen.size === 0) {
      this.logger.warn(`refusing to delist ${market}/${provider}: the run saw zero instruments`);
      return 0;
    }

    const candidates = await this.prisma.universeInstrument.findMany({
      where: { market, provider, status: { not: 'DELISTED' } },
      select: { id: true, ref: true },
    });
    const stale = candidates.filter((c) => !seen.has(c.ref));
    if (stale.length === 0) return 0;

    // A complete run that suddenly cannot see most of a market is far more
    // likely to be an upstream fault than a mass delisting. Report it and stop
    // rather than acting on it.
    const share = stale.length / Math.max(1, candidates.length);
    if (share > 0.5 && candidates.length > 100) {
      this.logger.error(
        `refusing to delist ${stale.length}/${candidates.length} of ${market}/${provider} ` +
          `(${Math.round(share * 100)}%) — that is an upstream fault, not a delisting event`,
      );
      return 0;
    }

    const now = new Date();
    let delisted = 0;
    for (let i = 0; i < stale.length; i += WRITE_BATCH) {
      const batch = stale.slice(i, i + WRITE_BATCH).map((s) => s.id);
      const { count } = await this.prisma.universeInstrument.updateMany({
        where: { id: { in: batch } },
        data: { status: 'DELISTED', delistedAt: now },
      });
      delisted += count;
    }
    this.logger.log(`delisted ${delisted} instrument(s) in ${market}/${provider}`);
    return delisted;
  }

  private async openRun(source: string, markets: UniverseMarket[]) {
    return this.prisma.universeSyncRun.create({
      data: { source, market: markets.length === 1 ? markets[0] : null, status: 'RUNNING' },
      select: { id: true },
    });
  }

  private async closeRun(id: string, result: UniverseSyncSourceReport): Promise<void> {
    await this.prisma.universeSyncRun.update({
      where: { id },
      data: {
        status: result.status,
        finishedAt: new Date(),
        durationMs: result.durationMs,
        discovered: result.discovered,
        pages: result.pages,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        delisted: result.delisted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        truncated: result.truncated,
        errors: result.errors.length > 0 ? result.errors.slice(0, 20) : undefined,
      },
    });
  }
}

function emptyReport(
  source: string,
  status: UniverseSyncSourceReport['status'],
  markets: UniverseMarket[],
): UniverseSyncSourceReport {
  return {
    source,
    status,
    markets,
    discovered: 0,
    pages: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    rejected: 0,
    delisted: 0,
    truncated: false,
    errors: [],
    durationMs: 0,
  };
}
