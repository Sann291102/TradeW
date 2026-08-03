import { Injectable, Logger } from '@nestjs/common';
import { SOURCE_AUTHORITY, type KnowledgeCitation, type KnowledgeSourceKind } from '../types';

/**
 * A chunk of a source document, addressable by citation.
 *
 * `charStart`/`charEnd` are offsets into the *parsed* text of the source
 * document, so a citation can always be re-resolved by re-parsing the file —
 * the index is a cache, never the only copy of the truth.
 */
export interface IndexedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  sourceKind: KnowledgeSourceKind;
  /** 0-based position within the document. */
  index: number;
  charStart: number;
  charEnd: number;
  /** Nearest preceding heading, when the parser found one. */
  section: string | null;
  /** Page number, when the source exposes pagination. */
  page: number | null;
  text: string;
  /** Term → frequency within this chunk. Precomputed for BM25. */
  termFreq: Record<string, number>;
  /** Total term count, i.e. document length for BM25 normalisation. */
  length: number;
}

export interface SearchHit {
  chunk: IndexedChunk;
  /** BM25 score scaled to 0..1 across the result set, then authority-weighted. */
  score: number;
  /** Query terms that actually matched — used to pick the citation quote. */
  matchedTerms: string[];
}

export interface IndexStats {
  documents: number;
  chunks: number;
  terms: number;
  indexedAt: string | null;
  byKind: Record<string, number>;
}

/** BM25 term-frequency saturation. 1.2–2.0 is the standard band. */
const BM25_K1 = 1.4;
/** BM25 length normalisation. 0.75 is the standard default. */
const BM25_B = 0.75;

/**
 * Words carrying no retrieval signal. Kept deliberately small: aggressive
 * stoplists strip domain terms that matter here ("above", "below", "high",
 * "low" are all meaningful in a trading corpus).
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'may',
  'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were',
  'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * The corpus index: an in-memory BM25 store over every learned chunk.
 *
 * Why lexical BM25 rather than vectors-only. The Brain already has a pgvector
 * path (`PrismaMemoryStore`) and this module uses it when it is available —
 * but that path needs Postgres AND an embedding provider, and SentinelIntelligence
 * must be able to answer with real citations on a laptop with neither. A
 * self-contained lexical index makes the citation guarantee unconditional:
 * every claim is checkable in dev, in CI, and offline, not only when the
 * infrastructure happens to be up. Where embeddings ARE available, semantic
 * hits are merged in by `KnowledgeRetrievalGateway` rather than replacing this.
 *
 * The index is rebuilt from the corpus, so it is disposable by design.
 */
@Injectable()
export class KnowledgeIndexService {
  private readonly logger = new Logger(KnowledgeIndexService.name);

  private chunks = new Map<string, IndexedChunk>();
  /** term → chunkIds containing it. The inverted index. */
  private postings = new Map<string, Set<string>>();
  private documentIds = new Set<string>();
  private totalLength = 0;
  private indexedAt: string | null = null;

  /** Replaces the entire index. Called by the ingestion service. */
  replaceAll(chunks: IndexedChunk[], indexedAt: string): void {
    this.chunks = new Map();
    this.postings = new Map();
    this.documentIds = new Set();
    this.totalLength = 0;
    for (const chunk of chunks) this.insert(chunk);
    this.indexedAt = indexedAt;
    this.logger.log(`index built: ${this.chunks.size} chunks / ${this.documentIds.size} documents / ${this.postings.size} terms`);
  }

  /** Adds or replaces the chunks of a single document — the incremental path. */
  upsertDocument(sourceId: string, chunks: IndexedChunk[]): void {
    this.removeDocument(sourceId);
    for (const chunk of chunks) this.insert(chunk);
  }

  removeDocument(sourceId: string): number {
    let removed = 0;
    for (const [id, chunk] of this.chunks) {
      if (chunk.sourceId !== sourceId) continue;
      this.chunks.delete(id);
      this.totalLength -= chunk.length;
      removed++;
      for (const term of Object.keys(chunk.termFreq)) {
        const set = this.postings.get(term);
        if (!set) continue;
        set.delete(id);
        if (set.size === 0) this.postings.delete(term);
      }
    }
    if (removed > 0) this.documentIds.delete(sourceId);
    return removed;
  }

  private insert(chunk: IndexedChunk): void {
    this.chunks.set(chunk.chunkId, chunk);
    this.documentIds.add(chunk.sourceId);
    this.totalLength += chunk.length;
    for (const term of Object.keys(chunk.termFreq)) {
      let set = this.postings.get(term);
      if (!set) {
        set = new Set();
        this.postings.set(term, set);
      }
      set.add(chunk.chunkId);
    }
  }

  get size(): number {
    return this.chunks.size;
  }

  stats(): IndexStats {
    const byKind: Record<string, number> = {};
    const seenDocs = new Set<string>();
    for (const chunk of this.chunks.values()) {
      if (seenDocs.has(chunk.sourceId)) continue;
      seenDocs.add(chunk.sourceId);
      byKind[chunk.sourceKind] = (byKind[chunk.sourceKind] ?? 0) + 1;
    }
    return {
      documents: this.documentIds.size,
      chunks: this.chunks.size,
      terms: this.postings.size,
      indexedAt: this.indexedAt,
      byKind,
    };
  }

  allChunks(): IndexedChunk[] {
    return [...this.chunks.values()];
  }

  getChunk(chunkId: string): IndexedChunk | null {
    return this.chunks.get(chunkId) ?? null;
  }

  /**
   * BM25 search, authority-weighted by corpus tier.
   *
   * `preferKinds` lets an agent bias toward the corpus it should be reasoning
   * from — the Strategy agent prefers `user-rule` and `book` over the
   * engineering vault — without hard-filtering, so a strong hit from a lower
   * tier still surfaces rather than being silently dropped.
   */
  search(
    query: string,
    opts: { limit?: number; preferKinds?: KnowledgeSourceKind[]; minScore?: number } = {},
  ): SearchHit[] {
    const limit = opts.limit ?? 8;
    const terms = tokenize(query);
    if (terms.length === 0 || this.chunks.size === 0) return [];

    const avgLength = this.totalLength / Math.max(1, this.chunks.size);
    const N = this.chunks.size;

    // Score only chunks that contain at least one query term — the whole point
    // of the inverted index. Scanning every chunk would be O(corpus) per query.
    const scores = new Map<string, { score: number; matched: Set<string> }>();
    const uniqueTerms = [...new Set(terms)];

    for (const term of uniqueTerms) {
      const posting = this.postings.get(term);
      if (!posting || posting.size === 0) continue;
      // Standard BM25 IDF with the +0.5 smoothing that keeps very common terms
      // from going negative and subtracting from otherwise-good matches.
      const df = posting.size;
      const idf = Math.max(0.01, Math.log(1 + (N - df + 0.5) / (df + 0.5)));

      for (const chunkId of posting) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) continue;
        const tf = chunk.termFreq[term] ?? 0;
        const norm = tf * (BM25_K1 + 1);
        const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.length / Math.max(1, avgLength)));
        const contribution = idf * (norm / Math.max(1e-9, denom));

        const entry = scores.get(chunkId) ?? { score: 0, matched: new Set<string>() };
        entry.score += contribution;
        entry.matched.add(term);
        scores.set(chunkId, entry);
      }
    }

    if (scores.size === 0) return [];

    // Normalise to 0..1 against the best raw score so downstream confidence
    // math has a bounded input, then apply corpus authority and a coverage
    // bonus for chunks that matched more of the query.
    const maxRaw = Math.max(...[...scores.values()].map((s) => s.score));
    const preferred = new Set(opts.preferKinds ?? []);

    const hits: SearchHit[] = [];
    for (const [chunkId, entry] of scores) {
      const chunk = this.chunks.get(chunkId)!;
      const normalised = maxRaw > 0 ? entry.score / maxRaw : 0;
      const coverage = entry.matched.size / uniqueTerms.length;
      const authority = SOURCE_AUTHORITY[chunk.sourceKind] ?? 0.5;
      const preferenceBoost = preferred.has(chunk.sourceKind) ? 1.15 : 1;
      const score = Math.min(1, normalised * (0.65 + 0.35 * coverage) * authority * preferenceBoost);
      if (opts.minScore !== undefined && score < opts.minScore) continue;
      hits.push({ chunk, score, matchedTerms: [...entry.matched] });
    }

    hits.sort((a, b) => b.score - a.score);
    return diversify(hits, limit);
  }

  /**
   * Turn a hit into a citation, selecting the sentence that best supports it.
   *
   * The quote is verbatim — never a paraphrase — because a citation whose text
   * was rewritten cannot be verified against the source, which defeats the
   * purpose of citing at all.
   */
  toCitation(hit: SearchHit): KnowledgeCitation {
    const quote = bestQuote(hit.chunk.text, hit.matchedTerms);
    const locator =
      hit.chunk.section ??
      (hit.chunk.page !== null ? `p. ${hit.chunk.page}` : `chunk ${hit.chunk.index + 1}`);

    return {
      chunkId: hit.chunk.chunkId,
      sourceId: hit.chunk.sourceId,
      sourceTitle: hit.chunk.sourceTitle,
      sourcePath: hit.chunk.sourcePath,
      sourceKind: hit.chunk.sourceKind,
      locator,
      charStart: hit.chunk.charStart,
      charEnd: hit.chunk.charEnd,
      quote,
      relevance: Number(hit.score.toFixed(4)),
    };
  }

  /** Convenience: search and return citations directly. */
  cite(query: string, opts: { limit?: number; preferKinds?: KnowledgeSourceKind[] } = {}): KnowledgeCitation[] {
    return this.search(query, opts).map((hit) => this.toCitation(hit));
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so they can be unit-tested without a Nest container.
// ---------------------------------------------------------------------------

/**
 * Tokenize for indexing and querying.
 *
 * Numbers are kept: strike prices, RSI thresholds and Fibonacci ratios are
 * genuinely meaningful query terms in this corpus. Hyphenated compounds are
 * emitted BOTH joined and split, so "supply-demand" matches a chunk that
 * writes "supply and demand".
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9%.\-\s]/g, ' ')
    .split(/\s+/);

  for (const token of raw) {
    const cleaned = token.replace(/^[.\-]+|[.\-]+$/g, '');
    if (cleaned.length < 2 || cleaned.length > 40) continue;
    if (STOPWORDS.has(cleaned)) continue;
    if (/^\d+\.?\d*$/.test(cleaned) && cleaned.length > 8) continue; // stray long numerals
    out.push(cleaned);
    if (cleaned.includes('-')) {
      for (const part of cleaned.split('-')) {
        if (part.length >= 3 && !STOPWORDS.has(part)) out.push(part);
      }
    }
  }
  return out;
}

export function termFrequencies(tokens: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1;
  return freq;
}

/**
 * Cap how many chunks any one document contributes to a result set.
 *
 * Without this, a single book whose vocabulary happens to match the query
 * takes every slot and the agent "corroborates" its claim against one author
 * repeated eight times. Diversity across sources is what makes corroboration
 * mean anything.
 */
function diversify(hits: SearchHit[], limit: number): SearchHit[] {
  const perDocumentCap = Math.max(1, Math.ceil(limit / 3));
  const counts = new Map<string, number>();
  const out: SearchHit[] = [];
  const overflow: SearchHit[] = [];

  for (const hit of hits) {
    const used = counts.get(hit.chunk.sourceId) ?? 0;
    if (used >= perDocumentCap) {
      overflow.push(hit);
      continue;
    }
    counts.set(hit.chunk.sourceId, used + 1);
    out.push(hit);
    if (out.length === limit) return out;
  }
  // Backfill from overflow only if diversification left the result set short.
  for (const hit of overflow) {
    if (out.length === limit) break;
    out.push(hit);
  }
  return out;
}

/**
 * Pick the single sentence in a chunk that carries the most query terms.
 *
 * Falls back to the chunk's opening when no sentence matches, so a citation
 * always has a quote rather than an empty string.
 */
export function bestQuote(text: string, matchedTerms: string[], maxChars = 320): string {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24);

  if (sentences.length === 0) return truncate(text.trim(), maxChars);

  const terms = new Set(matchedTerms);
  let best = sentences[0];
  let bestScore = -1;

  for (const sentence of sentences) {
    const tokens = tokenize(sentence);
    if (tokens.length === 0) continue;
    let hits = 0;
    for (const token of new Set(tokens)) if (terms.has(token)) hits++;
    // Density, not raw count — otherwise the longest sentence always wins.
    const score = hits + hits / Math.sqrt(tokens.length);
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return truncate(best, maxChars);
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}
