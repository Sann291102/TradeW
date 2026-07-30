/**
 * Shared types for the Sentinel Learning module.
 *
 * The Learning module is upstream of the Brain. Every type here describes a
 * stage of the ingestion pipeline; runtime Brain types (ConceptNode,
 * MemoryRecord, GraphNode) are re-used from ai-core / brain modules and are
 * not redeclared.
 */

export type DocumentKind = 'pdf' | 'docx' | 'markdown' | 'text';

export interface BookFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Repo-relative path, used as a stable id and in source references. */
  relativePath: string;
  /** Filename without extension. */
  title: string;
  /** File extension without leading dot. */
  extension: string;
  kind: DocumentKind;
  /** Bytes on disk. */
  sizeBytes: number;
  /** Last-modified time. */
  mtimeMs: number;
  /** sha256 of the raw file — used to skip unchanged files on rescans. */
  checksum: string;
}

export interface ParsedDocument {
  book: BookFile;
  /** Raw plain text, whitespace normalised. */
  text: string;
  /** Pages detected in the source, when the parser can expose them. */
  pageCount: number | null;
  /** Author, title, and other embedded metadata when the parser exposes it. */
  meta: DocumentMetadata;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  producer?: string;
  creator?: string;
  creationDate?: string;
  keywords?: string[];
  /** Sections detected in the text (Markdown headings, top-of-page titles). */
  sections?: SectionMarker[];
}

export interface SectionMarker {
  /** Approximate character offset into ParsedDocument.text. */
  offset: number;
  /** 1 for top-level, 2 for subsection, etc. */
  level: number;
  title: string;
}

export interface Chunk {
  /** Deterministic id: `<book-checksum>:<index>`. */
  id: string;
  book: BookFile;
  /** 0-based index of this chunk within the document. */
  index: number;
  /** Approximate token count for embedding cost estimation. */
  approxTokens: number;
  /** Character offset of the chunk start in the parsed text. */
  charStart: number;
  /** Character offset of the chunk end in the parsed text. */
  charEnd: number;
  /** Nearest section marker (heading) preceding this chunk, if any. */
  section: SectionMarker | null;
  text: string;
  /** Content hash of the chunk text, used to skip unchanged chunks on re-ingest. */
  checksum: string;
}

export interface ExtractedConcept {
  /** Concept id from knowledge-base/ (e.g. 'liquidity-sweep'). */
  conceptId: string;
  /** Human-friendly concept name at match time. */
  name: string;
  /** Which of the 15 Brain domains this concept belongs to. */
  domain: string;
  /** 0..1 — proportion of chunk sentences that mention it, weighted by match quality. */
  confidence: number;
  /** All match positions within the chunk. */
  matches: ConceptMatch[];
}

export interface ConceptMatch {
  /** Character offset within the chunk text. */
  offset: number;
  /** The literal substring matched (canonical name or alias). */
  matchedText: string;
  /** True when matched against the concept's canonical name; false for an alias. */
  isCanonicalName: boolean;
}

/**
 * A proposed relation between two concepts inferred from co-occurrence and
 * cue phrases within a chunk. Never auto-applied — surfaced for review.
 */
export interface RelationshipProposal {
  fromConceptId: string;
  toConceptId: string;
  /** One of the 13 concept-graph relation types, or `co_occurs_with` for pure co-occurrence. */
  relation: string;
  /** 0..1 — cue-phrase matches carry higher weight than raw proximity. */
  confidence: number;
  /** The sentence or fragment that suggested the relation. */
  evidence: string;
  chunkId: string;
}

export type IngestionStatus = 'queued' | 'parsing' | 'chunking' | 'extracting' | 'importing' | 'done' | 'failed';

export interface IngestionJob {
  jobId: string;
  bookRelativePath: string;
  bookChecksum: string;
  status: IngestionStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Populated as the job progresses. */
  metrics: IngestionMetrics;
}

export interface IngestionMetrics {
  pagesParsed: number;
  charactersExtracted: number;
  chunksCreated: number;
  conceptsExtracted: number;
  relationshipsProposed: number;
  memoryRecordsWritten: number;
  graphNodesWritten: number;
  graphEdgesWritten: number;
  durationMs: number;
}

export const EMPTY_METRICS: IngestionMetrics = {
  pagesParsed: 0,
  charactersExtracted: 0,
  chunksCreated: 0,
  conceptsExtracted: 0,
  relationshipsProposed: 0,
  memoryRecordsWritten: 0,
  graphNodesWritten: 0,
  graphEdgesWritten: 0,
  durationMs: 0,
};
