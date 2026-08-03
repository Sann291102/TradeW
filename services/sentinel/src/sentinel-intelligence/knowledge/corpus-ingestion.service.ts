import { gunzipSync, gzipSync } from 'zlib';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DocumentParserService } from '../../learning/document-parser.service';
import type { BookFile, ParsedDocument, SectionMarker } from '../../learning/types';
import { SI_CONFIG, SentinelIntelligenceConfig } from '../si.config';
import { CorpusScannerService, type CorpusDocument } from './corpus-scanner.service';
import { KnowledgeIndexService, termFrequencies, tokenize, type IndexedChunk } from './knowledge-index.service';
import { ReasoningGraphService } from './reasoning-graph.service';

export interface IngestionReport {
  scanned: number;
  parsed: number;
  unchanged: number;
  failed: { path: string; error: string }[];
  skipped: { path: string; reason: string }[];
  chunksIndexed: number;
  conceptsGrounded: number;
  durationMs: number;
  indexedAt: string;
}

/** Persisted index payload. Versioned so a format change re-indexes rather than crashes. */
interface PersistedIndex {
  version: 1;
  indexedAt: string;
  /** sourceId → checksum, so an unchanged file is never re-parsed. */
  documents: Record<string, { checksum: string; path: string; title: string }>;
  chunks: IndexedChunk[];
}

const INDEX_VERSION = 1 as const;

/**
 * Builds and maintains the SentinelIntelligence corpus.
 *
 * Continuous learning is implemented as *idempotent re-ingestion* rather than a
 * background daemon: `ingest()` is cheap to call repeatedly because unchanged
 * documents are detected by content checksum and skipped entirely. That makes
 * the same entrypoint usable from boot, from an operator endpoint, and from a
 * cron/n8n schedule without three different code paths and without a
 * long-lived worker that can silently die and leave the corpus stale.
 *
 * Parsing reuses the existing `DocumentParserService` (pdf/docx/text) untouched.
 * Chunking is local to this module because the chunk *is* the citation unit
 * here — its boundaries have to align with document sections so a citation can
 * name "§3.2 Liquidity Sweeps" rather than "chunk 47".
 */
@Injectable()
export class CorpusIngestionService {
  private readonly logger = new Logger(CorpusIngestionService.name);
  /** sourceId → checksum of the last successfully indexed version. */
  private indexedChecksums = new Map<string, string>();
  private inFlight: Promise<IngestionReport> | null = null;

  constructor(
    @Inject(SI_CONFIG) private readonly config: SentinelIntelligenceConfig,
    private readonly scanner: CorpusScannerService,
    private readonly parser: DocumentParserService,
    private readonly index: KnowledgeIndexService,
    private readonly graph: ReasoningGraphService,
  ) {}

  /**
   * Scan, parse and index the corpus.
   *
   * Concurrent callers share one run: indexing a 30 MB PDF corpus twice in
   * parallel would double the memory and produce identical output, so the
   * second caller awaits the first rather than starting its own pass.
   */
  async ingest(opts: { force?: boolean } = {}): Promise<IngestionReport> {
    if (this.inFlight) {
      this.logger.log('ingestion already in progress — awaiting the in-flight run');
      return this.inFlight;
    }
    this.inFlight = this.runIngestion(opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runIngestion(opts: { force?: boolean }): Promise<IngestionReport> {
    const started = Date.now();
    const force = opts.force === true;

    if (!force) await this.loadPersisted();

    const scan = await this.scanner.scan();
    const failed: { path: string; error: string }[] = [];
    let parsed = 0;
    let unchanged = 0;

    for (const document of scan.documents) {
      // Checksum is the document id, so "already processed" is a single lookup.
      //
      // Keyed on having been PROCESSED, not on having produced chunks. A file
      // that legitimately yields zero chunks — an image-only PDF, a stub README
      // shorter than minChunkChars — is fully handled, and gating on chunk
      // presence would re-parse it on every single run, forever.
      if (!force && this.indexedChecksums.has(document.checksum)) {
        unchanged++;
        continue;
      }
      try {
        const chunks = await this.ingestDocument(document);
        this.index.upsertDocument(document.checksum, chunks);
        this.indexedChecksums.set(document.checksum, document.checksum);
        parsed++;
      } catch (err) {
        // One unreadable book must never abort the corpus. An image-only PDF
        // parses to empty text and produces zero chunks — that is a successful
        // parse with nothing to index, not a failure, and is handled below.
        failed.push({ path: document.relativePath, error: (err as Error).message });
        this.logger.warn(`ingestion failed for ${document.relativePath}: ${(err as Error).message}`);
      }
    }

    // Drop documents that disappeared from disk, so a deleted note stops being
    // citable. Retention lives in git, not in a stale in-memory index.
    const live = new Set(scan.documents.map((d) => d.checksum));
    for (const sourceId of [...this.indexedChecksums.keys()]) {
      if (live.has(sourceId)) continue;
      this.index.removeDocument(sourceId);
      this.indexedChecksums.delete(sourceId);
    }

    const indexedAt = new Date().toISOString();
    this.index.replaceAll(this.index.allChunks(), indexedAt);

    // Re-ground the ontology against whatever the corpus now contains. On the
    // first run the graph has not been built yet, so build it; afterwards a
    // re-ground is enough and avoids re-reading 66 YAML files.
    const conceptsGrounded = this.graph.size === 0 ? this.graph.build().groundedConcepts : this.graph.reground();

    await this.persist(indexedAt, scan.documents).catch((err) => {
      this.logger.warn(`could not persist corpus index (non-fatal): ${(err as Error).message}`);
    });

    const report: IngestionReport = {
      scanned: scan.documents.length,
      parsed,
      unchanged,
      failed,
      skipped: scan.skipped,
      chunksIndexed: this.index.size,
      conceptsGrounded,
      durationMs: Date.now() - started,
      indexedAt,
    };
    this.logger.log(
      `corpus ingest complete: ${report.chunksIndexed} chunks from ${report.scanned} documents ` +
        `(${report.parsed} parsed, ${report.unchanged} unchanged, ${report.failed.length} failed) in ${report.durationMs}ms`,
    );
    return report;
  }

  private async ingestDocument(document: CorpusDocument): Promise<IndexedChunk[]> {
    const parsedDocument = await this.parser.parse(toBookFile(document));
    if (parsedDocument.text.trim().length === 0) {
      this.logger.debug(`${document.relativePath}: parsed to empty text (likely image-only) — nothing to index`);
      return [];
    }
    return this.chunk(document, parsedDocument);
  }

  /**
   * Split a parsed document into citation-sized chunks.
   *
   * Boundaries prefer paragraph breaks inside the target window so a citation
   * quote is never cut mid-sentence, and each chunk records the nearest
   * preceding heading so `locator` reads as a section rather than an index.
   */
  private chunk(document: CorpusDocument, parsedDocument: ParsedDocument): IndexedChunk[] {
    const { text, meta, pageCount } = parsedDocument;
    const sections = meta.sections ?? [];
    const { chunkChars, chunkOverlapChars, minChunkChars, maxChunksPerDocument } = this.config;

    const chunks: IndexedChunk[] = [];
    let cursor = 0;
    let index = 0;

    while (cursor < text.length) {
      if (maxChunksPerDocument > 0 && index >= maxChunksPerDocument) break;

      const hardEnd = Math.min(text.length, cursor + chunkChars);
      const end = hardEnd >= text.length ? text.length : preferredBreak(text, cursor, hardEnd);
      const slice = text.slice(cursor, end);
      const trimmed = slice.trim();

      if (trimmed.length >= minChunkChars) {
        const tokens = tokenize(trimmed);
        // A chunk of pure page furniture (numbers, running heads) tokenizes to
        // almost nothing; indexing it would add noise with no retrievable signal.
        if (tokens.length >= 12) {
          chunks.push({
            chunkId: `${document.checksum}:${index}`,
            sourceId: document.checksum,
            sourceTitle: meta.title?.trim() || document.title,
            sourcePath: document.relativePath,
            sourceKind: document.sourceKind,
            index,
            charStart: cursor,
            charEnd: end,
            section: nearestSection(sections, cursor),
            page: estimatePage(cursor, text.length, pageCount),
            text: trimmed,
            termFreq: termFrequencies(tokens),
            length: tokens.length,
          });
          index++;
        }
      }

      if (end >= text.length) break;
      // Overlap backwards so a concept spanning a boundary is retrievable from
      // both sides. `Math.max` guards against a pathological zero-advance loop
      // when a break lands very close to the cursor.
      cursor = Math.max(cursor + 1, end - chunkOverlapChars);
    }

    return chunks;
  }

  // ------------------------------------------------------------- persistence

  private async persist(indexedAt: string, documents: CorpusDocument[]): Promise<void> {
    const manifest: PersistedIndex['documents'] = {};
    for (const doc of documents) {
      if (!this.indexedChecksums.has(doc.checksum)) continue;
      manifest[doc.checksum] = { checksum: doc.checksum, path: doc.relativePath, title: doc.title };
    }

    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      indexedAt,
      documents: manifest,
      chunks: this.index.allChunks(),
    };

    // gzip, not raw JSON: the full book corpus serialises to well over a
    // hundred megabytes of mostly-English text, which compresses roughly 4:1.
    await mkdir(dirname(this.config.indexFile), { recursive: true });
    await writeFile(`${this.config.indexFile}.gz`, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')));
  }

  /**
   * Restore a previously built index so a restart does not re-parse every PDF.
   *
   * Any failure here is non-fatal by design — a corrupt or stale-format cache
   * must degrade to "index from scratch", never to a service that will not boot.
   */
  private async loadPersisted(): Promise<void> {
    if (this.index.size > 0) return;
    const path = `${this.config.indexFile}.gz`;
    if (!existsSync(path)) return;

    try {
      const raw = JSON.parse(gunzipSync(await readFile(path)).toString('utf8')) as PersistedIndex;
      if (raw.version !== INDEX_VERSION || !Array.isArray(raw.chunks)) {
        this.logger.log('persisted corpus index has an incompatible version — rebuilding');
        return;
      }
      this.index.replaceAll(raw.chunks, raw.indexedAt);
      this.indexedChecksums = new Map(Object.keys(raw.documents).map((id) => [id, id]));
      this.logger.log(`restored corpus index: ${raw.chunks.length} chunks indexed at ${raw.indexedAt}`);
    } catch (err) {
      this.logger.warn(`could not restore corpus index, rebuilding: ${(err as Error).message}`);
      this.indexedChecksums = new Map();
    }
  }

  /** Corpus state, for the audit trail attached to every reasoning run. */
  corpusState() {
    const indexStats = this.index.stats();
    return {
      documents: indexStats.documents,
      chunks: indexStats.chunks,
      concepts: this.graph.size,
      indexedAt: indexStats.indexedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct unit testing.
// ---------------------------------------------------------------------------

/** `CorpusDocument` → the `BookFile` shape the existing parser expects. */
export function toBookFile(document: CorpusDocument): BookFile {
  return {
    absolutePath: document.absolutePath,
    relativePath: document.relativePath,
    title: document.title,
    extension: document.extension,
    kind: document.kind,
    sizeBytes: document.sizeBytes,
    mtimeMs: document.mtimeMs,
    checksum: document.checksum,
  };
}

/**
 * Find a natural break at or before `hardEnd`, preferring a paragraph boundary
 * and falling back to a sentence end. Returns `hardEnd` when neither exists
 * within the last quarter of the window, so a wall of unbroken text still
 * chunks at the configured size instead of running to the end of the document.
 */
export function preferredBreak(text: string, start: number, hardEnd: number): number {
  const windowStart = start + Math.floor((hardEnd - start) * 0.75);

  const paragraph = text.lastIndexOf('\n\n', hardEnd);
  if (paragraph > windowStart) return paragraph + 2;

  const newline = text.lastIndexOf('\n', hardEnd);
  if (newline > windowStart) return newline + 1;

  for (const terminator of ['. ', '? ', '! ']) {
    const at = text.lastIndexOf(terminator, hardEnd);
    if (at > windowStart) return at + terminator.length;
  }
  return hardEnd;
}

/** The heading immediately preceding an offset, or null. */
export function nearestSection(sections: SectionMarker[], offset: number): string | null {
  let best: SectionMarker | null = null;
  for (const marker of sections) {
    if (marker.offset > offset) break; // markers arrive in ascending order
    best = marker;
  }
  return best ? best.title : null;
}

/**
 * Approximate a page number by linear interpolation through the text.
 *
 * Deliberately approximate, and only ever used as a fallback `locator` when a
 * section heading is unavailable — pdf-parse does not expose per-page offsets,
 * and an approximate "p. 148" is materially more useful for finding a passage
 * in a book than "chunk 312".
 */
export function estimatePage(offset: number, totalChars: number, pageCount: number | null): number | null {
  if (!pageCount || pageCount <= 0 || totalChars <= 0) return null;
  return Math.max(1, Math.min(pageCount, Math.ceil((offset / totalChars) * pageCount)));
}
