import { Injectable, Logger } from '@nestjs/common';
import { marketStatusAt, type MarketStatus } from '@tradew/market-data';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketDataService, type QuoteDto } from '../../market-data/market-data.service';

/**
 * Evidence assembly for the analysis path — stage 3 of the request pipeline
 * (`TRADEW-ASSISTANT.md` §9).
 *
 * ## The rule this service exists to enforce
 *
 * The assistant must never present invented or simulated numbers as real
 * market data. That is not a prompt instruction here — no market number
 * reaches the model except through this service, and every batch it returns
 * carries a `provenance` block naming the feed each figure came from and
 * whether that feed is live.
 *
 * `Quote.source` is the authority: it records what the ingestor actually
 * wrote, defaulting to `simulated`. The repo already learned this lesson once
 * (the fabricated-candles fix), and this service inherits it rather than
 * re-deriving provenance from configuration, which can disagree with the data.
 *
 * When the feed is simulated, `provenance.live` is false and the orchestrator
 * is required to say so in the answer. A simulated tape is still useful for
 * demonstrating and testing the reasoning path; passing it off as NIFTY's real
 * price is the thing that must not happen.
 */

/** Feed identifiers that represent a real market. Anything else is not live. */
const LIVE_SOURCES = new Set(['dhan', 'twelvedata', 'binance']);

export interface EvidenceProvenance {
  /** Distinct `Quote.source` values behind the figures in this batch. */
  feeds: string[];
  /** True only when every figure came from a real market feed. */
  live: boolean;
  /** Oldest `updatedAt` across the batch — how stale the freshest answer can be. */
  asOf: string | null;
  staleSeconds: number | null;
  marketStatus: MarketStatus;
  /** Present when `live` is false. Rendered to the user verbatim. */
  caveat?: string;
}

export interface MarketEvidence {
  /** Instruments the question referred to, resolved and quoted. */
  quotes: QuoteDto[];
  /** Index backdrop, always included for market-structure questions. */
  indices: QuoteDto[];
  /** Symbols mentioned in the question that no instrument matched. */
  unresolved: string[];
  provenance: EvidenceProvenance;
}

/**
 * Aliases users actually type or say, mapped to canonical instrument symbols.
 * Speech-to-text in particular produces "bank nifty" and "nifty fifty".
 */
const SYMBOL_ALIASES: Record<string, string> = {
  nifty: 'NIFTY',
  'nifty 50': 'NIFTY',
  'nifty fifty': 'NIFTY',
  nifty50: 'NIFTY',
  banknifty: 'BANKNIFTY',
  'bank nifty': 'BANKNIFTY',
  'nifty bank': 'BANKNIFTY',
  finnifty: 'FINNIFTY',
  'fin nifty': 'FINNIFTY',
  midcpnifty: 'MIDCPNIFTY',
  'midcap nifty': 'MIDCPNIFTY',
  sensex: 'SENSEX',
};

@Injectable()
export class MarketContextService {
  private readonly log = new Logger(MarketContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {}

  /**
   * Resolve the instruments a question refers to.
   *
   * Alias table first (multi-word aliases before single tokens so "bank nifty"
   * does not resolve as "nifty"), then a symbol lookup against the instrument
   * table for anything that looks like a ticker.
   */
  async resolveSymbols(text: string): Promise<{ symbols: string[]; unresolved: string[] }> {
    const lower = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
    const found = new Set<string>();

    const aliases = Object.keys(SYMBOL_ALIASES).sort((a, b) => b.length - a.length);
    let remaining = lower;
    for (const alias of aliases) {
      if (remaining.includes(` ${alias} `)) {
        found.add(SYMBOL_ALIASES[alias]);
        remaining = remaining.replaceAll(` ${alias} `, ' ');
      }
    }

    // Uppercase tokens in the ORIGINAL text are candidate tickers ("RELIANCE").
    const candidates = Array.from(
      new Set((text.match(/\b[A-Z][A-Z0-9&-]{2,}\b/g) ?? []).map((t) => t.toUpperCase())),
    ).filter((t) => !found.has(t));

    const unresolved: string[] = [];
    if (candidates.length > 0) {
      const matches = await this.prisma.instrument.findMany({
        where: { symbol: { in: candidates } },
        select: { symbol: true },
      });
      const matched = new Set(matches.map((m) => m.symbol));
      for (const c of candidates) {
        if (matched.has(c)) found.add(c);
        else unresolved.push(c);
      }
    }

    return { symbols: [...found], unresolved };
  }

  /**
   * Gather evidence for a question.
   *
   * Returns whatever is genuinely available. Missing data is reported as
   * missing — never substituted, never estimated.
   */
  async gather(text: string, now: Date = new Date()): Promise<MarketEvidence> {
    const { symbols, unresolved } = await this.resolveSymbols(text);

    const [quotes, allIndices] = await Promise.all([
      symbols.length > 0 ? this.safeQuotes(symbols) : Promise.resolve([]),
      this.safeIndices(),
    ]);

    // An index named in the question appears in BOTH lists otherwise — asking
    // about NIFTY put NIFTY in `quotes` and again in the index backdrop, which
    // reached the model as a duplicate row and the user as "NIFTY 24850"
    // twice. The referenced instrument wins; the backdrop is context around it.
    const referenced = new Set(quotes.map((q) => q.symbol));
    const indices = allIndices.filter((q) => !referenced.has(q.symbol));

    return {
      quotes,
      indices,
      unresolved,
      provenance: this.provenanceOf([...quotes, ...indices], now),
    };
  }

  /**
   * Provenance for a set of quotes.
   *
   * `live` is conjunctive on purpose: one simulated figure in an answer makes
   * the whole answer not-live, because the user cannot tell which sentence
   * came from which feed.
   */
  provenanceOf(quotes: QuoteDto[], now: Date = new Date()): EvidenceProvenance {
    const feeds = [...new Set(quotes.map((q) => q.source))].sort();
    const live = quotes.length > 0 && feeds.every((f) => LIVE_SOURCES.has(f));

    const oldest = quotes.reduce<Date | null>((acc, q) => {
      const t = new Date(q.updatedAt);
      return acc === null || t < acc ? t : acc;
    }, null);

    const simulated = feeds.filter((f) => !LIVE_SOURCES.has(f));

    return {
      feeds,
      live,
      asOf: oldest ? oldest.toISOString() : null,
      staleSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null,
      marketStatus: marketStatusAt(now),
      caveat:
        quotes.length === 0
          ? undefined
          : simulated.length > 0
            ? `These figures come from TradeW's ${simulated.join('/')} feed, not a live exchange feed. Treat the levels as illustrative — the structure of the analysis is real, the prices are not.`
            : undefined,
    };
  }

  /** Quotes for symbols, tolerating individually missing rows. */
  private async safeQuotes(symbols: string[]): Promise<QuoteDto[]> {
    try {
      return await this.marketData.quotesBySymbols(symbols);
    } catch (err) {
      this.log.warn(`quote lookup failed for ${symbols.join(',')}: ${String(err)}`);
      return [];
    }
  }

  private async safeIndices(): Promise<QuoteDto[]> {
    try {
      return await this.marketData.indices();
    } catch (err) {
      this.log.warn(`index lookup failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Render evidence as the compact, explicitly-labelled block handed to the
   * model. Labelled because the model must be able to tell data from
   * instruction, and must not be able to read a price as a directive.
   */
  static toPromptBlock(evidence: MarketEvidence): string {
    const lines: string[] = [];
    const fmt = (q: QuoteDto) =>
      `${q.symbol} (${q.displayName}): last ${q.ltp}, change ${q.change} (${q.changePct}%), ` +
      `open ${q.open}, high ${q.high}, low ${q.low}, prev close ${q.close}, volume ${q.volume}, ` +
      `feed=${q.source}, as of ${new Date(q.updatedAt).toISOString()}`;

    if (evidence.quotes.length) {
      lines.push('INSTRUMENTS REFERENCED:');
      for (const q of evidence.quotes) lines.push(`- ${fmt(q)}`);
    }
    if (evidence.indices.length) {
      lines.push('INDEX BACKDROP:');
      for (const q of evidence.indices) lines.push(`- ${fmt(q)}`);
    }
    if (evidence.unresolved.length) {
      lines.push(`NOT FOUND (no instrument matched, do not invent data): ${evidence.unresolved.join(', ')}`);
    }

    lines.push(
      `DATA PROVENANCE: feeds=${evidence.provenance.feeds.join('/') || 'none'}; ` +
        `live=${evidence.provenance.live}; market=${evidence.provenance.marketStatus}; ` +
        `as_of=${evidence.provenance.asOf ?? 'n/a'}`,
    );
    if (evidence.provenance.caveat) {
      lines.push(`REQUIRED DISCLOSURE: ${evidence.provenance.caveat}`);
    }
    if (!evidence.quotes.length && !evidence.indices.length) {
      lines.push('NO MARKET DATA AVAILABLE. Say so plainly. Do not estimate or recall figures from training.');
    }

    return lines.join('\n');
  }
}
