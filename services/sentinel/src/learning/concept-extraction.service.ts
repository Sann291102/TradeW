import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OntologyLoaderService } from '../brain/ontology/ontology-loader.service';
import { DOMAINS } from '../brain/ontology/domains';
import { Concept } from '../brain/ontology/concept.schema';
import { Chunk, ExtractedConcept, ConceptMatch } from './types';

interface ConceptIndexEntry {
  conceptId: string;
  domain: string;
  canonicalName: string;
  /** Lowercased phrases: canonical name, alias, and id-as-words. */
  phrases: { text: string; isCanonical: boolean }[];
}

/**
 * Concept Extraction Service — surfaces which of the Brain's canonical
 * concepts appear in a chunk of text.
 *
 * Extraction is deterministic and grounded in the existing 66-concept
 * ontology (loaded via OntologyLoaderService) — it never invents concept
 * ids, never fabricates new domains, and never returns a match that a
 * reviewer could not verify by grepping the chunk text. The match is
 * case-insensitive with a word-boundary check to keep "capital" from
 * matching inside "capitalise", but permissive enough to catch plurals
 * (aliases carry them explicitly when they matter).
 *
 * Confidence is `matches * quality / (matches + 3)` — a Bayesian-shrinkage
 * pattern that keeps a single stray mention from claiming a high score
 * while letting sustained co-occurrence reach ≥0.7.
 */
@Injectable()
export class ConceptExtractionService implements OnModuleInit {
  private readonly logger = new Logger(ConceptExtractionService.name);
  private index: ConceptIndexEntry[] = [];
  private domainRegexes: Map<string, RegExp> = new Map();

  constructor(private readonly loader: OntologyLoaderService) {}

  onModuleInit(): void {
    this.rebuildIndex();
  }

  rebuildIndex(): void {
    const result = this.loader.load();
    this.index = result.concepts.map(({ concept }) => this.entryFor(concept));
    this.buildDomainRegexes();
    this.logger.log(`concept index: ${this.index.length} concepts across ${DOMAINS.length} domains`);
  }

  extract(chunk: Chunk): ExtractedConcept[] {
    if (!chunk.text || chunk.text.length === 0) return [];
    const text = chunk.text;
    const lower = text.toLowerCase();

    const byConcept = new Map<string, ExtractedConcept>();

    for (const entry of this.index) {
      const matches: ConceptMatch[] = [];
      for (const phrase of entry.phrases) {
        const pattern = this.phrasePattern(phrase.text);
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(lower)) !== null) {
          matches.push({
            offset: m.index,
            matchedText: text.substring(m.index, m.index + m[0].length),
            isCanonicalName: phrase.isCanonical,
          });
        }
      }
      if (matches.length === 0) continue;

      const canonicalHits = matches.filter((m) => m.isCanonicalName).length;
      const quality = 0.5 + 0.5 * (canonicalHits / matches.length);
      const confidence = Math.min(1, (matches.length * quality) / (matches.length + 3));

      byConcept.set(entry.conceptId, {
        conceptId: entry.conceptId,
        name: entry.canonicalName,
        domain: entry.domain,
        confidence: Number(confidence.toFixed(3)),
        matches,
      });
    }

    return [...byConcept.values()].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Domain fallback — used when a chunk touches a domain (e.g. talks about
   * "call options" repeatedly) but does not name a specific canonical
   * concept. The result is a synthetic ExtractedConcept with id
   * `domain:<domain>` so it can be tagged on the MemoryRecord without
   * pretending to be a real ontology concept.
   */
  detectDomains(text: string): { domain: string; hits: number }[] {
    const lower = text.toLowerCase();
    const out: { domain: string; hits: number }[] = [];
    for (const [domain, regex] of this.domainRegexes) {
      const matches = lower.match(regex);
      if (matches && matches.length > 0) out.push({ domain, hits: matches.length });
    }
    return out.sort((a, b) => b.hits - a.hits);
  }

  /** Size of the loaded concept index — surfaced for smoke tests and health. */
  size(): number {
    return this.index.length;
  }

  private entryFor(concept: Concept): ConceptIndexEntry {
    const phrases: { text: string; isCanonical: boolean }[] = [];
    phrases.push({ text: concept.name.toLowerCase(), isCanonical: true });
    // The id-with-spaces reads naturally in prose (`liquidity-sweep` ↔ `liquidity sweep`).
    const idPhrase = concept.id.replace(/-/g, ' ').toLowerCase();
    if (idPhrase !== concept.name.toLowerCase()) phrases.push({ text: idPhrase, isCanonical: true });
    for (const alias of concept.aliases) {
      const a = alias.toLowerCase().trim();
      if (a.length > 0) phrases.push({ text: a, isCanonical: false });
    }
    return {
      conceptId: concept.id,
      domain: concept.domain,
      canonicalName: concept.name,
      phrases,
    };
  }

  private phrasePattern(phrase: string): RegExp {
    // Escape regex metacharacters, then wrap in word boundaries. Multi-word
    // phrases keep internal spaces flexible (whitespace or newline collapse).
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, 'g');
  }

  private buildDomainRegexes(): void {
    // Broad keyword sets per Brain domain, used as a fallback when no canonical
    // concept matches. Deliberately conservative — over-broad terms would tag
    // every chunk with every domain.
    const buckets: Record<string, string[]> = {
      'market-structure': ['trend', 'range', 'swing high', 'swing low', 'breakout', 'consolidation', 'timeframe', 'higher high', 'lower low'],
      'price-action': ['candle', 'wick', 'engulfing', 'pin bar', 'rejection', 'expansion', 'contraction'],
      options: ['call option', 'put option', 'strike', 'expiry', 'implied volatility', 'greeks', 'delta', 'gamma', 'theta', 'vega'],
      'technical-analysis': ['moving average', 'rsi', 'macd', 'stochastic', 'bollinger', 'indicator'],
      volume: ['volume profile', 'accumulation', 'distribution', 'volume spike', 'obv'],
      'market-microstructure': ['bid', 'ask', 'spread', 'order book', 'slippage', 'depth', 'liquidity provider'],
      macroeconomics: ['inflation', 'interest rate', 'fed', 'monetary policy', 'gdp', 'unemployment', 'cpi'],
      'trading-psychology': ['fear', 'greed', 'fomo', 'revenge', 'discipline', 'patience', 'confidence', 'emotion'],
      'risk-management': ['position sizing', 'stop loss', 'risk of ruin', 'drawdown', 'risk reward', 'kelly'],
      'institutional-concepts': ['institutional', 'smart money', 'order block', 'liquidity sweep', 'fair value gap', 'mitigation', 'ict', 'smc'],
      'company-fundamentals': ['earnings', 'valuation', 'balance sheet', 'guidance', 'p/e ratio', 'revenue'],
      derivatives: ['futures', 'basis', 'rollover', 'contango', 'backwardation', 'open interest'],
      sentiment: ['sentiment', 'put call ratio', 'breadth', 'fear index', 'vix', 'positioning'],
      patterns: ['double top', 'double bottom', 'head and shoulders', 'triangle', 'wedge', 'flag', 'pennant'],
      glossary: ['definition', 'terminology', 'glossary'],
    };
    this.domainRegexes.clear();
    for (const [domain, terms] of Object.entries(buckets)) {
      const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
      this.domainRegexes.set(domain, new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi'));
    }
  }
}
