import { Injectable, Logger } from '@nestjs/common';
import { InstrumentType, Prisma } from '@prisma/client';
import { ExchangeSegment, mergeScripMasters, parseScripMaster, ScripMasterRow } from '@tradew/market-data';
import { PrismaService } from '../prisma.service';

/**
 * Synchronises `Instrument` from Dhan's published scrip master.
 *
 * Phase 1 of DHAN-MARKET-DATA-INTEGRATION.md. This is the step that makes the
 * application metadata-driven: without `(exchangeSegment, securityId)` on every
 * instrument, no Dhan REST call or WebSocket subscription can be constructed.
 *
 * Two design constraints shape the whole implementation:
 *
 * 1. `Instrument.symbol` is globally unique, and the full master collides
 *    immediately — RELIANCE exists on both NSE and BSE, and option contracts
 *    share base symbols. Rather than weaken that constraint (which would break
 *    `findUnique({ where: { symbol } })` behind /market-data/quote-by-symbol),
 *    the sync runs against a segment allowlist and *reports* collisions instead
 *    of silently mangling or overwriting them.
 *
 * 2. Nothing is ever deleted. Instruments absent from a full sync are
 *    deactivated (`active: false`), because Order/Trade/Position rows reference
 *    them permanently — CLAUDE.md Rule 1 applied to data.
 */

/**
 * Both published masters are needed — neither carries everything.
 * Compact holds the exchange ticker (the platform's `symbol`); detailed holds
 * ISIN and underlying. See `mergeScripMasters` for why.
 */
export const SCRIP_MASTER_COMPACT_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
export const SCRIP_MASTER_DETAILED_URL = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

/**
 * Default scope. Indices are already seeded and only need their securityId
 * filled in; NSE equity is ~2,000 collision-free symbols and covers the equity
 * quote, Market Movers and Trending Stocks use cases. F&O and BSE are opt-in
 * because enabling them requires deciding the symbol-uniqueness policy first.
 */
export const DEFAULT_SEGMENTS: ExchangeSegment[] = ['IDX_I', 'NSE_EQ'];

/**
 * Cash-segment series to import.
 *
 * NSE's equity segment is mostly not equities: of 9,620 rows, ~4,300 are SDL
 * state government bonds and the rest include T-bills, mutual funds and
 * government securities. Only ~2,400 are shares.
 *
 * This is not a cosmetic filter — measured against the live master, importing
 * every series produces 417 symbol collisions, while EQ + BE produces 1. Since
 * `Instrument.symbol` is globally unique, the series filter is what makes the
 * import viable at all without weakening that constraint.
 *
 *   EQ — normal rolling-settlement equity
 *   BE — trade-to-trade equity (still shares, settlement differs)
 *
 * Rows with a blank series (indices, derivatives) always pass.
 */
export const DEFAULT_SERIES = ['EQ', 'BE'];

export interface SyncOptions {
  segments?: ExchangeSegment[];
  /** Cash-segment series allowlist. Defaults to DEFAULT_SERIES. */
  series?: string[];
  /** Parse and report without writing. */
  dryRun?: boolean;
  /** Deactivate active instruments in scope that the master no longer lists. */
  deactivateMissing?: boolean;
  /** Cap rows for a smoke run. */
  limit?: number;
  compactUrl?: string;
  detailedUrl?: string;
  /** Supply CSV directly instead of downloading (tests, offline runs). */
  compactCsv?: string;
  detailedCsv?: string;
}

export interface SyncReport {
  segments: ExchangeSegment[];
  series: string[];
  dryRun: boolean;
  totalRowsParsed: number;
  skippedRows: number;
  outOfScopeRows: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  symbolCollisions: Array<{ symbol: string; keptSecurityId: string; rejected: string }>;
  errors: string[];
  durationMs: number;
}

@Injectable()
export class ScripMasterService {
  private readonly logger = new Logger(ScripMasterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(options: SyncOptions = {}): Promise<SyncReport> {
    const startedAt = Date.now();
    const segments = options.segments ?? DEFAULT_SEGMENTS;
    const series = options.series ?? DEFAULT_SERIES;
    const report: SyncReport = {
      segments,
      series,
      dryRun: options.dryRun ?? false,
      totalRowsParsed: 0,
      skippedRows: 0,
      outOfScopeRows: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      symbolCollisions: [],
      errors: [],
      durationMs: 0,
    };

    const [compactCsv, detailedCsv] = await Promise.all([
      options.compactCsv ?? this.download(options.compactUrl ?? SCRIP_MASTER_COMPACT_URL, 'compact'),
      options.detailedCsv ?? this.download(options.detailedUrl ?? SCRIP_MASTER_DETAILED_URL, 'detailed'),
    ]);

    const parseOptions = { segments, series, limit: options.limit };
    const compact = parseScripMaster(compactCsv, parseOptions);
    // The detailed file is parsed unlimited: a `limit` applied to it would drop
    // the very rows the compact side needs to join against.
    const detailed = parseScripMaster(detailedCsv, { segments, series });

    const parsed = {
      rows: mergeScripMasters(compact.rows, detailed.rows),
      skipped: [...compact.skipped, ...detailed.skipped],
      outOfScope: compact.outOfScope,
    };
    report.totalRowsParsed = parsed.rows.length;
    report.skippedRows = parsed.skipped.length;
    report.outOfScopeRows = parsed.outOfScope;

    if (parsed.skipped.length > 0) {
      // Surfaced rather than swallowed: a header change upstream would
      // otherwise show up as a quietly empty import.
      this.logger.warn(`${parsed.skipped.length} row(s) skipped; first: ${parsed.skipped[0].reason}`);
    }

    // Resolve symbol collisions before touching the database, so the outcome is
    // deterministic rather than dependent on row order mid-transaction.
    const { accepted, collisions } = this.resolveSymbolCollisions(parsed.rows);
    report.symbolCollisions = collisions;

    const seenSecurityIds = new Set<string>();

    for (const row of accepted) {
      seenSecurityIds.add(`${row.exchangeSegment}:${row.securityId}`);
      try {
        const outcome = await this.upsertInstrument(row, report.dryRun);
        if (outcome === 'created') report.created++;
        else if (outcome === 'updated') report.updated++;
        else report.unchanged++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push(`${row.tradingSymbol} (${row.securityId}): ${message}`);
      }
    }

    if (options.deactivateMissing && !report.dryRun && !options.limit) {
      report.deactivated = await this.deactivateMissing(segments, seenSecurityIds);
    }

    report.durationMs = Date.now() - startedAt;
    return report;
  }

  private async download(url: string, label: string): Promise<string> {
    this.logger.log(`downloading ${label} scrip master`);
    // Node 20+ has global fetch, so no HTTP dependency is needed here.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${label} scrip master download failed: HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    this.logger.log(`downloaded ${label}: ${(text.length / 1_048_576).toFixed(1)} MiB`);
    return text;
  }

  /**
   * One platform symbol maps to at most one instrument. Where several rows want
   * the same symbol, the first by (segment order, securityId) wins and the rest
   * are reported. Deterministic and visible — never a silent overwrite.
   */
  private resolveSymbolCollisions(rows: ScripMasterRow[]): {
    accepted: ScripMasterRow[];
    collisions: SyncReport['symbolCollisions'];
  } {
    const bySymbol = new Map<string, ScripMasterRow>();
    const collisions: SyncReport['symbolCollisions'] = [];

    const ordered = [...rows].sort((a, b) => {
      const segCompare = DEFAULT_SEGMENTS.indexOf(a.exchangeSegment) - DEFAULT_SEGMENTS.indexOf(b.exchangeSegment);
      if (segCompare !== 0) return segCompare;
      return a.securityId.localeCompare(b.securityId);
    });

    for (const row of ordered) {
      const symbol = this.platformSymbol(row);
      const existing = bySymbol.get(symbol);
      if (!existing) {
        bySymbol.set(symbol, row);
        continue;
      }
      collisions.push({
        symbol,
        keptSecurityId: `${existing.exchangeSegment}:${existing.securityId}`,
        rejected: `${row.exchangeSegment}:${row.securityId}`,
      });
    }

    return { accepted: [...bySymbol.values()], collisions };
  }

  /**
   * The platform-canonical symbol for a master row.
   *
   * The exchange ticker — `RELIANCE`, not `RELIANCE INDUSTRIES LTD`. This comes
   * from the compact master's SEM_TRADING_SYMBOL; the detailed master has no
   * ticker column, and using its SYMBOL_NAME here would make every equity
   * unsearchable by the name users actually type.
   */
  private platformSymbol(row: ScripMasterRow): string {
    return row.tradingSymbol.trim().toUpperCase();
  }

  private async upsertInstrument(row: ScripMasterRow, dryRun: boolean): Promise<'created' | 'updated' | 'unchanged'> {
    const symbol = this.platformSymbol(row);

    // Match on broker identity first — it is the stable key. Falling back to
    // symbol is what lets an already-seeded instrument (NIFTY, seeded long
    // before any broker mapping existed) be enriched in place rather than
    // duplicated.
    const existing =
      (await this.prisma.instrument.findFirst({
        where: { exchangeSegment: row.exchangeSegment, securityId: row.securityId },
      })) ?? (await this.prisma.instrument.findUnique({ where: { symbol } }));

    const data = {
      displayName: row.displayName || symbol,
      type: this.instrumentType(row),
      exchange: row.exchange,
      securityId: row.securityId,
      exchangeSegment: row.exchangeSegment,
      isin: row.isin ?? null,
      dhanInstrument: row.instrument ?? null,
      series: row.series ?? null,
      expiryFlag: row.expiryFlag ?? null,
      tradingSymbol: row.tradingSymbol,
      underlyingSecurityId: row.underlyingSecurityId ?? null,
      underlying: row.underlyingSymbol ?? null,
      expiryDate: row.expiryDate ?? null,
      strikePrice: row.strikePrice !== undefined ? new Prisma.Decimal(row.strikePrice) : null,
      optionType: row.optionType ?? null,
      lotSize: row.lotSize ?? 1,
      tickSize: row.tickSize !== undefined ? new Prisma.Decimal(row.tickSize) : new Prisma.Decimal(0.05),
      active: true,
      metadataSource: 'dhan-scrip-master',
      metadataSyncedAt: new Date(),
    };

    if (!existing) {
      if (!dryRun) await this.prisma.instrument.create({ data: { symbol, ...data } });
      return 'created';
    }

    // When a row was matched on broker identity but carries a different symbol,
    // the symbol is corrected — but only if no other instrument already holds
    // it, since Instrument.symbol is globally unique. Losing the race here
    // would fail the whole sync on a constraint violation.
    const withSymbol: Record<string, unknown> = { ...data };
    if (existing.symbol !== symbol) {
      const taken = await this.prisma.instrument.findUnique({ where: { symbol }, select: { id: true } });
      if (!taken || taken.id === existing.id) {
        withSymbol.symbol = symbol;
      } else {
        this.logger.warn(`cannot rename ${existing.symbol} -> ${symbol}: symbol already held by another instrument`);
      }
    }

    // Skip no-op writes so a re-run does not churn updatedAt on every row —
    // which is what makes the sync genuinely incremental.
    if (!this.hasChanged(existing, withSymbol)) return 'unchanged';
    if (!dryRun) await this.prisma.instrument.update({ where: { id: existing.id }, data: withSymbol });
    return 'updated';
  }

  private hasChanged(existing: Record<string, unknown>, next: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(next)) {
      // Both are set on every sync by definition; comparing them would make
      // every row look changed.
      if (key === 'metadataSyncedAt' || key === 'metadataSource') continue;
      const current = existing[key];
      if (value instanceof Prisma.Decimal || current instanceof Prisma.Decimal) {
        if (String(current ?? '') !== String(value ?? '')) return true;
      } else if (value instanceof Date || current instanceof Date) {
        const a = value instanceof Date ? value.getTime() : null;
        const b = current instanceof Date ? current.getTime() : null;
        if (a !== b) return true;
      } else if ((current ?? null) !== (value ?? null)) {
        return true;
      }
    }
    return false;
  }

  /** Map the exchange's instrument class onto the platform enum. */
  private instrumentType(row: ScripMasterRow): InstrumentType {
    const kind = (row.instrument ?? '').toUpperCase();
    if (row.exchangeSegment === 'IDX_I' || kind === 'INDEX') return InstrumentType.INDEX;
    if (kind.startsWith('OPT') || row.optionType) return InstrumentType.OPTION;
    if (kind.startsWith('FUT')) return InstrumentType.FUTURE;
    return InstrumentType.EQUITY;
  }

  /**
   * Deactivate — never delete — instruments in scope that the master dropped.
   * Only runs on a full (unlimited) sync, since a limited run's absence proves
   * nothing about delisting.
   */
  private async deactivateMissing(segments: ExchangeSegment[], seen: Set<string>): Promise<number> {
    const candidates = await this.prisma.instrument.findMany({
      where: { active: true, exchangeSegment: { in: segments }, metadataSource: 'dhan-scrip-master' },
      select: { id: true, exchangeSegment: true, securityId: true },
    });

    const stale = candidates.filter((c) => !seen.has(`${c.exchangeSegment}:${c.securityId}`));
    if (stale.length === 0) return 0;

    await this.prisma.instrument.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { active: false, metadataSyncedAt: new Date() },
    });
    this.logger.log(`deactivated ${stale.length} instrument(s) no longer in the master`);
    return stale.length;
  }
}
