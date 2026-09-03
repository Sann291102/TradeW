import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { SourceFetcherService } from '../ingestion/source-fetcher.service';
import { FILING_DATASETS } from '../catalogue/filing-datasets';
import {
  choosePrimaryListing,
  EquityListRow,
  normalizeIdentifier,
  parseEquityList,
  securityKindFromIsin,
} from './equity-list.parser';

/**
 * Builds the company identity spine from NSE's `EQUITY_L.csv`.
 *
 * ── WHAT THIS OWNS ─────────────────────────────────────────────────────────
 * `Company`, `SecurityListing` and `CompanyAlias` for every NSE-listed company,
 * plus the link from each listing to the tradable `Instrument` that shares its
 * ISIN. It is the job that makes "search any company" true, and it is the only
 * writer of these three tables.
 *
 * ── BULK, NOT A LOOP OF UPSERTS ────────────────────────────────────────────
 * 2,553 companies × (1 company + 1 listing + 3 aliases) is ~12,700 rows. As a
 * loop of upserts that is ~12,700 round trips, which on a first run is minutes
 * of held connection for work that is a handful of statements. So existing
 * state is loaded into maps once, the diff is computed in memory, and writes go
 * out as batched `createMany`/`updateMany`.
 *
 * ── CONFLICTS ARE RECORDED, NOT RESOLVED BY ACCIDENT ───────────────────────
 * `CompanyAlias` is uniquely keyed on (kind, normalized) precisely so an
 * identifier cannot point at two companies. `createMany({skipDuplicates})`
 * would honour that constraint while telling nobody — the second claimant would
 * simply lose, silently, and search would resolve to whichever company happened
 * to be inserted first. So collisions are detected BEFORE the write and written
 * to `DataQualityResult` as `alias.conflict`. That is the plan's "when two
 * sources disagree, do not silently pick one" applied at the identity layer.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Re-running changes nothing when the file has not changed. The fetcher's
 * content-hash short-circuit means an unchanged file is not even parsed.
 */

/** NSE is the only exchange this connector reads. BSE is a separate connector. */
const EXCHANGE = 'NSE';

export interface EquityListSyncResult {
  status: 'ok' | 'unchanged' | 'failed';
  parsed: number;
  skipped: number;
  companiesCreated: number;
  listingsCreated: number;
  listingsUpdated: number;
  aliasesCreated: number;
  aliasConflicts: number;
  instrumentsLinked: number;
  contentHash?: string;
}

@Injectable()
export class EquityListConnector {
  private readonly logger = new Logger(EquityListConnector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: SourceFetcherService,
  ) {}

  /**
   * Fetch, parse and reconcile.
   *
   * `knownHash` comes from the job checkpoint: when the file is byte-identical
   * to the last run there is nothing to reconcile, and re-deriving 12,700 rows
   * to discover that would be the exact waste the incremental design exists to
   * avoid.
   */
  async sync(knownHash?: string | null): Promise<EquityListSyncResult> {
    const empty = {
      parsed: 0,
      skipped: 0,
      companiesCreated: 0,
      listingsCreated: 0,
      listingsUpdated: 0,
      aliasesCreated: 0,
      aliasConflicts: 0,
      instrumentsLinked: 0,
    };

    const fetched = await this.fetcher.fetchDataset({
      dataset: FILING_DATASETS['nse.equity-list'],
      knownHash,
    });

    if (fetched.status !== 'ok' || !fetched.body) {
      return { ...empty, status: fetched.status, contentHash: fetched.contentHash };
    }

    const { rows, skipped } = parseEquityList(fetched.body);

    if (skipped.length > 0) {
      // Visible in the database, not only in a log line nobody reads. A run
      // that quietly drops rows produces a company list that is wrong in a way
      // nothing downstream can detect.
      await this.prisma.dataQualityResult.create({
        data: {
          entity: 'SecurityListing',
          entityId: 'nse.equity-list',
          check: 'equity-list.unparsed-rows',
          severity: skipped.length > rows.length * 0.01 ? 'error' : 'warn',
          passed: false,
          // Capped at 50: the detail column is for diagnosis, not for a second
          // copy of the file. `totalSkipped` keeps the real count honest.
          detail: {
            skipped: skipped.slice(0, 50),
            totalSkipped: skipped.length,
            parsed: rows.length,
          } as unknown as Prisma.InputJsonObject,
          sourceRecordId: fetched.sourceRecordId,
        },
      });
    }

    const result = await this.reconcile(rows, fetched.sourceRecordId);

    return {
      ...result,
      status: 'ok',
      parsed: rows.length,
      skipped: skipped.length,
      contentHash: fetched.contentHash,
    };
  }

  private async reconcile(rows: EquityListRow[], sourceRecordId: string) {
    // ---- Load current state once ----
    const [existingListings, instruments, existingAliases] = await Promise.all([
      this.prisma.securityListing.findMany({
        where: { exchange: EXCHANGE },
        select: {
          id: true,
          symbol: true,
          companyId: true,
          isin: true,
          series: true,
          instrumentId: true,
          faceValue: true,
          paidUpValue: true,
          active: true,
        },
      }),
      // Equity instruments only. An index or a derivative sharing an ISIN
      // prefix must never be linked as a company's listing.
      this.prisma.instrument.findMany({
        where: { exchangeSegment: 'NSE_EQ', isin: { not: null } },
        select: { id: true, isin: true },
      }),
      this.prisma.companyAlias.findMany({ select: { kind: true, normalized: true, companyId: true } }),
    ]);

    const listingBySymbol = new Map(existingListings.map((l) => [l.symbol, l]));
    const instrumentByIsin = new Map(instruments.map((i) => [i.isin as string, i.id]));
    const aliasOwner = new Map(existingAliases.map((a) => [`${a.kind}:${a.normalized}`, a.companyId]));

    const newCompanies: { id: string; name: string; kind: string; sourceRecordId: string }[] = [];
    const newListings: Record<string, unknown>[] = [];
    const newAliases: { id: string; companyId: string; kind: string; value: string; normalized: string }[] = [];
    const conflicts: { key: string; value: string; existingCompanyId: string; symbol: string }[] = [];
    const shareClassGroups: { name: string; symbols: string[]; primary: string }[] = [];
    const updates: { id: string; data: Record<string, unknown> }[] = [];

    let instrumentsLinked = 0;

    // ---- Existing listings: update only what differs ----
    const unseen: EquityListRow[] = [];
    for (const row of rows) {
      const existing = listingBySymbol.get(row.symbol);
      if (!existing) {
        unseen.push(row);
        continue;
      }
      const instrumentId = instrumentByIsin.get(row.isin) ?? null;
      // An update that rewrites identical values still bumps updatedAt on 2,553
      // rows every day, which turns "what changed recently" into a useless
      // question.
      const data: Record<string, unknown> = {};
      if (existing.isin !== row.isin) data.isin = row.isin;
      if (existing.series !== row.series) data.series = row.series;
      if (existing.instrumentId !== instrumentId && instrumentId) {
        data.instrumentId = instrumentId;
        instrumentsLinked += 1;
      }
      if (numberChanged(existing.faceValue, row.faceValue)) data.faceValue = row.faceValue;
      if (numberChanged(existing.paidUpValue, row.paidUpValue)) data.paidUpValue = row.paidUpValue;
      if (!existing.active) data.active = true; // relisted
      if (Object.keys(data).length > 0) updates.push({ id: existing.id, data });
    }

    // ---- New listings, GROUPED BY ISSUER NAME ----
    //
    // WHY GROUP AT ALL. One issuer can list more than one class of share:
    // ordinary plus DVR (differential voting rights), or partly paid. On
    // 2026-08-19 EQUITY_L.csv carried three such pairs — FEL/FELDVR,
    // GATECH/GATECHDVR, JISLDVREQS/JISLJALEQS — two symbols and two ISINs for
    // ONE company each, distinguishable by ISIN prefix (IN9 = variant,
    // INE = ordinary).
    //
    // Treating each symbol as its own company would give Jain Irrigation two
    // half-populated research pages, each later claiming its own copy of the
    // same filings. Grouping on the legal name — which the exchange spells
    // identically for both classes, and which is exactly what the alias
    // uniqueness constraint flagged — makes them one company with two listings.
    const groups = new Map<string, EquityListRow[]>();
    for (const row of unseen) {
      const key = normalizeIdentifier(row.name || row.symbol);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    for (const [nameKey, group] of groups) {
      // An issuer already stored under this name takes the new listings;
      // otherwise this is a new company.
      const existingOwner = aliasOwner.get(`name:${nameKey}`);
      const companyId = existingOwner ?? randomUUID();
      const primary = choosePrimaryListing(group);

      if (!existingOwner) {
        newCompanies.push({
          id: companyId,
          name: primary.name || primary.symbol,
          kind: securityKindFromIsin(primary.isin),
          sourceRecordId,
        });
        aliasOwner.set(`name:${nameKey}`, companyId);
        newAliases.push({
          id: randomUUID(),
          companyId,
          kind: 'name',
          value: primary.name || primary.symbol,
          normalized: nameKey,
        });
      }

      if (group.length > 1) {
        shareClassGroups.push({ name: primary.name, symbols: group.map((r) => r.symbol), primary: primary.symbol });
      }

      for (const row of group) {
        const instrumentId = instrumentByIsin.get(row.isin) ?? null;
        if (instrumentId) instrumentsLinked += 1;
        newListings.push({
          id: randomUUID(),
          companyId,
          exchange: EXCHANGE,
          symbol: row.symbol,
          isin: row.isin,
          series: row.series || null,
          listedOn: row.listedOn,
          faceValue: row.faceValue,
          paidUpValue: row.paidUpValue,
          // Exactly one primary per company: the class a page shows when it has
          // to pick a single price.
          isPrimary: row.symbol === primary.symbol,
          instrumentId,
          sourceRecordId,
        });

        // Symbol and ISIN are per LISTING and cannot legitimately collide
        // between share classes of one issuer. A collision here is therefore a
        // genuine identity conflict — two different issuers claiming one
        // identifier — and is recorded rather than resolved by insertion order.
        for (const [kind, value] of [
          ['symbol', row.symbol],
          ['isin', row.isin],
        ] as const) {
          const normalized = normalizeIdentifier(value);
          const key = `${kind}:${normalized}`;
          const owner = aliasOwner.get(key);
          if (owner && owner !== companyId) {
            conflicts.push({ key, value, existingCompanyId: owner, symbol: row.symbol });
            continue;
          }
          aliasOwner.set(key, companyId);
          newAliases.push({ id: randomUUID(), companyId, kind, value, normalized });
        }
      }
    }

    // ---- Write ----
    // Companies before listings/aliases: both carry a foreign key to Company,
    // so the reverse order fails on the constraint.
    if (newCompanies.length > 0) {
      await this.prisma.company.createMany({ data: newCompanies, skipDuplicates: true });
    }
    if (newListings.length > 0) {
      await this.prisma.securityListing.createMany({ data: newListings as never, skipDuplicates: true });
    }
    if (newAliases.length > 0) {
      await this.prisma.companyAlias.createMany({ data: newAliases, skipDuplicates: true });
    }
    for (const u of updates) {
      await this.prisma.securityListing.update({ where: { id: u.id }, data: u.data });
    }

    if (shareClassGroups.length > 0) {
      // Informational, not a fault. Recorded so that merging two symbols into
      // one company is an auditable decision rather than something that quietly
      // happened inside a loop.
      await this.prisma.dataQualityResult.create({
        data: {
          entity: 'Company',
          entityId: 'nse.equity-list',
          check: 'company.share-classes-merged',
          severity: 'info',
          passed: true,
          detail: {
            groups: shareClassGroups.slice(0, 50),
            total: shareClassGroups.length,
          } as unknown as Prisma.InputJsonObject,
          sourceRecordId,
        },
      });
      this.logger.log(`${shareClassGroups.length} multi-share-class issuers merged into one company each`);
    }

    if (conflicts.length > 0) {
      await this.prisma.dataQualityResult.create({
        data: {
          entity: 'CompanyAlias',
          entityId: 'nse.equity-list',
          check: 'alias.conflict',
          severity: 'warn',
          passed: false,
          detail: { conflicts: conflicts.slice(0, 50), total: conflicts.length } as unknown as Prisma.InputJsonObject,
          sourceRecordId,
        },
      });
      this.logger.warn(`${conflicts.length} alias conflicts recorded from EQUITY_L.csv`);
    }

    return {
      companiesCreated: newCompanies.length,
      listingsCreated: newListings.length,
      listingsUpdated: updates.length,
      aliasesCreated: newAliases.length,
      aliasConflicts: conflicts.length,
      instrumentsLinked,
    };
  }
}

/**
 * Decimal-vs-number comparison.
 *
 * Prisma hands back a Decimal object for a DECIMAL column, so `existing.faceValue
 * !== row.faceValue` is ALWAYS true — object versus number — and every row would
 * be reported as changed on every run.
 */
function numberChanged(existing: unknown, incoming: number | null): boolean {
  if (existing === null || existing === undefined) return incoming !== null;
  if (incoming === null) return true;
  return Number(existing) !== incoming;
}
