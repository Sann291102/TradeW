import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Company identity — resolution and lookup.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 * The research page currently knows nine companies, as a literal array, with a
 * price fallback of `symbol === 'RELIANCE' ? 2945.20 : 1500.00`. This service
 * is the reason that array can be deleted: any of ~2,550 NSE-listed companies
 * resolves from a name, a symbol or an ISIN to ONE canonical record.
 *
 * ── EXACT BEFORE FUZZY, ALWAYS ─────────────────────────────────────────────
 * `resolve()` answers only on an exact alias match, and `search()` puts exact
 * matches first. That ordering is not a nicety: typing "INFY" must land on
 * Infosys, not on whichever company happens to contain that substring in a
 * longer name. Ranking a fuzzy hit above an exact one is how a search box
 * silently sends a user to the wrong company's fundamentals.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * No prices, no market cap, no fundamentals. Identity only. Market cap in
 * particular is deliberately absent rather than approximated: it needs a share
 * count, which lives in the XBRL filings, and inventing a multiplier to fill
 * the gap is exactly the `price * 670` this whole effort exists to remove.
 */

/** Must match `normalizeIdentifier` in services/company-data — see below. */
export function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

export interface CompanySummary {
  id: string;
  name: string;
  kind: string;
  sector: string | null;
  industry: string | null;
  symbol: string | null;
  exchange: string | null;
  isin: string | null;
  series: string | null;
  /** False when no broker instrument backs this listing — researchable, not priceable. */
  tradable: boolean;
  /** How the query matched: an exact identifier, or a name/symbol prefix. */
  matchedOn?: 'symbol' | 'isin' | 'name' | 'prefix';
}

const LISTING_SELECT = {
  symbol: true,
  exchange: true,
  isin: true,
  series: true,
  isPrimary: true,
  instrumentId: true,
} as const;

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve one identifier to one company.
   *
   * Returns null rather than a best guess. A caller that asked for a specific
   * identifier and got back "something similar" cannot tell the difference
   * between a hit and a near miss, and would render another company's data
   * under the name the user typed.
   */
  async resolve(identifier: string): Promise<CompanySummary | null> {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) return null;

    // One indexed lookup across all identifier kinds. Ordered by kind so that a
    // string which is somehow both a symbol and part of a name resolves as the
    // symbol — the more specific claim.
    const alias = await this.prisma.companyAlias.findFirst({
      where: { normalized },
      orderBy: { kind: 'asc' }, // 'isin' < 'name' < 'symbol' alphabetically
      include: { company: { include: { listings: { orderBy: { isPrimary: 'desc' } } } } },
    });
    if (!alias) return null;

    return toSummary(alias.company, alias.kind as CompanySummary['matchedOn']);
  }

  /**
   * Free-text search. Exact identifier matches first, then prefix matches.
   *
   * Deliberately prefix rather than `contains`: "REL" should offer RELIANCE,
   * not every company with "rel" buried mid-name. Substring matching also
   * cannot use the index, which on 2,550 companies is survivable and on a
   * BSE-inclusive universe is not.
   */
  async search(query: string, limit = 20): Promise<CompanySummary[]> {
    const normalized = normalizeIdentifier(query);
    if (normalized.length < 1) return [];

    const exact = await this.resolve(normalized);

    const prefixMatches = await this.prisma.companyAlias.findMany({
      where: { normalized: { startsWith: normalized } },
      // Deterministic, because without an explicit order Postgres is free to
      // return these in whatever order it likes and the same query can rank
      // differently between calls — which reads to a user as a search box that
      // cannot make up its mind.
      //
      // 'symbol' sorts after 'isin' and 'name' alphabetically, so descending
      // puts symbol matches first: someone typing "TATA" means a ticker more
      // often than a legal name. Within a kind, the shorter identifier wins —
      // "REL" offers RELAXO before RELIANCE INFRASTRUCTURE.
      //
      // This is ordering, not relevance. A real ranking wants market cap or
      // traded value, and neither exists until the statement pipeline lands;
      // pretending otherwise would just be an arbitrary rule with a confident
      // name.
      orderBy: [{ kind: 'desc' }, { normalized: 'asc' }],
      take: limit * 3, // several aliases can point at one company; dedupe below
      include: { company: { include: { listings: { orderBy: { isPrimary: 'desc' } } } } },
    });

    const seen = new Set<string>();
    const results: CompanySummary[] = [];

    if (exact) {
      seen.add(exact.id);
      results.push(exact);
    }

    for (const alias of prefixMatches) {
      if (seen.has(alias.companyId)) continue;
      seen.add(alias.companyId);
      results.push(toSummary(alias.company, 'prefix'));
      if (results.length >= limit) break;
    }

    return results;
  }

  /** Full identity record, including every listing. */
  async byId(id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        listings: { orderBy: { isPrimary: 'desc' }, select: { ...LISTING_SELECT, listedOn: true, faceValue: true } },
        aliases: { select: { kind: true, value: true } },
      },
    });
    if (!company) throw new NotFoundException(`No company with id ${id}`);

    return {
      id: company.id,
      name: company.name,
      kind: company.kind,
      // Null until a source provides them (Phase 4). Reported as null rather
      // than omitted, so a consumer can tell "not classified yet" from "field
      // does not exist".
      sector: company.sector,
      industry: company.industry,
      description: company.description,
      website: company.website,
      active: company.active,
      listings: company.listings.map((l) => ({
        symbol: l.symbol,
        exchange: l.exchange,
        isin: l.isin,
        series: l.series,
        isPrimary: l.isPrimary,
        listedOn: l.listedOn,
        faceValue: l.faceValue ? Number(l.faceValue) : null,
        tradable: l.instrumentId !== null,
      })),
      aliases: company.aliases,
    };
  }
}

type CompanyWithListings = {
  id: string;
  name: string;
  kind: string;
  sector: string | null;
  industry: string | null;
  listings: { symbol: string; exchange: string; isin: string; series: string | null; instrumentId: string | null }[];
};

function toSummary(company: CompanyWithListings, matchedOn?: CompanySummary['matchedOn']): CompanySummary {
  // Listings arrive primary-first, so [0] is the class a page should show when
  // it has to pick one. A company always has at least one listing (the
  // connector creates them together), but the optional chaining stays: a
  // future BSE-only or delisted path could produce none, and a crash in search
  // is a worse outcome than a null symbol.
  const listing = company.listings[0];
  return {
    id: company.id,
    name: company.name,
    kind: company.kind,
    sector: company.sector,
    industry: company.industry,
    symbol: listing?.symbol ?? null,
    exchange: listing?.exchange ?? null,
    isin: listing?.isin ?? null,
    series: listing?.series ?? null,
    tradable: listing?.instrumentId != null,
    matchedOn,
  };
}
