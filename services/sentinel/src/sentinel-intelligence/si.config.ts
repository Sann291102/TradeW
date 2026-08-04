import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * SentinelIntelligence configuration.
 *
 * Separate from `learning/learning.config.ts` on purpose: that config governs
 * the existing book-ingestion pipeline that feeds the Brain, and repointing it
 * would change what the production orchestrator reasons over. This one governs
 * only the SentinelIntelligence corpus, so the two can be tuned — or broken —
 * independently.
 */
export interface SentinelIntelligenceConfig {
  /** Repo root. Every corpus root below is resolved relative to this. */
  repoRoot: string;
  /**
   * Directories scanned for knowledge, in descending authority order. Each
   * entry maps a path to the corpus tier its documents are cited as.
   */
  corpusRoots: CorpusRoot[];
  /** Where the persisted corpus index/graph is written. */
  indexFile: string;
  /** Where learned TradingView rules are persisted. */
  rulesFile: string;
  /** Target characters per chunk. */
  chunkChars: number;
  /** Overlap between adjacent chunks so a concept spanning a boundary survives. */
  chunkOverlapChars: number;
  /** Chunks shorter than this are dropped as noise (nav lists, page furniture). */
  minChunkChars: number;
  /** Hard cap on indexed chunks per document — 0 disables the cap. */
  maxChunksPerDocument: number;
  /** Files larger than this are skipped with a logged reason. */
  maxFileBytes: number;
  /** Confidence gate, 0..1. An observation below this is never surfaced. */
  confidenceThreshold: number;
  /** Minimum non-abstaining agents that must agree before surfacing. */
  requiredCorroboration: number;
  /** Max citations attached to any single verdict. */
  maxCitationsPerVerdict: number;
  /** Retrieval fan-out per knowledge query. */
  retrievalLimit: number;
  /** Auto-index the corpus at boot. Off by default — indexing is I/O heavy. */
  indexOnBoot: boolean;
}

export interface CorpusRoot {
  /** Repo-relative directory. */
  path: string;
  kind: 'user-rule' | 'book' | 'knowledge-base' | 'vault' | 'doc' | 'generated';
  /** Extensions to include, lowercase, no dot. */
  extensions: string[];
  /** Recurse into subdirectories. */
  recursive: boolean;
}

/**
 * The 70% gate from the product brief, expressed on the 0..1 scale the
 * synthesis engine works in. Exported so tests assert against the constant
 * rather than a copied literal.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * "Corroboration from multiple agents" made concrete: two independent,
 * non-abstaining agents must land on the same stance. One agent at 95% is
 * still a single point of failure and stays silent.
 */
export const DEFAULT_REQUIRED_CORROBORATION = 2;

const DEFAULT_CHUNK_CHARS = 2400;
const DEFAULT_CHUNK_OVERLAP = 240;
const DEFAULT_MIN_CHUNK_CHARS = 280;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Corpus roots, in the order they are scanned.
 *
 * `knowledge/sentinel-learning` sits above the general `knowledge/` vault
 * because it is the authoring layer explicitly created to feed the Brain
 * (Decisions/2026-07-30), whereas the wider vault is engineering knowledge
 * about building TradeW — useful context, but not market knowledge, so it is
 * cited at the lower `vault` authority.
 */
const DEFAULT_CORPUS_ROOTS: CorpusRoot[] = [
  { path: 'docs/Trading Books', kind: 'book', extensions: ['pdf', 'docx', 'txt', 'md', 'epub'], recursive: true },
  { path: 'knowledge-base', kind: 'knowledge-base', extensions: ['yaml', 'yml', 'md'], recursive: true },
  { path: 'knowledge/sentinel-learning', kind: 'knowledge-base', extensions: ['md'], recursive: true },
  { path: 'knowledge', kind: 'vault', extensions: ['md'], recursive: true },
  { path: 'docs/product-architecture', kind: 'doc', extensions: ['md'], recursive: true },
  { path: 'docs/handbook', kind: 'doc', extensions: ['md'], recursive: true },
  { path: 'agents', kind: 'doc', extensions: ['md', 'json'], recursive: true },
];

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function unitInterval(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Accept either 0..1 or a 0..100 percentage, so `SI_CONFIDENCE_THRESHOLD=70`
  // and `=0.7` both mean the same thing rather than silently disabling the gate.
  const normalised = n > 1 ? n / 100 : n;
  if (normalised < 0 || normalised > 1) return fallback;
  return normalised;
}

export function loadSentinelIntelligenceConfig(
  env: NodeJS.ProcessEnv = process.env,
): SentinelIntelligenceConfig {
  const repoRoot = resolve(env.SI_REPO_ROOT || findRepoRoot());

  return {
    repoRoot,
    corpusRoots: DEFAULT_CORPUS_ROOTS,
    indexFile: resolve(env.SI_INDEX_FILE || resolve(repoRoot, 'services/sentinel/data/si-corpus.json')),
    rulesFile: resolve(env.SI_RULES_FILE || resolve(repoRoot, 'services/sentinel/data/si-tradingview-rules.json')),
    chunkChars: positiveInt(env.SI_CHUNK_CHARS, DEFAULT_CHUNK_CHARS),
    chunkOverlapChars: positiveInt(env.SI_CHUNK_OVERLAP, DEFAULT_CHUNK_OVERLAP),
    minChunkChars: positiveInt(env.SI_MIN_CHUNK_CHARS, DEFAULT_MIN_CHUNK_CHARS),
    maxChunksPerDocument: positiveInt(env.SI_MAX_CHUNKS_PER_DOC, 0),
    maxFileBytes: positiveInt(env.SI_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    confidenceThreshold: unitInterval(env.SI_CONFIDENCE_THRESHOLD, DEFAULT_CONFIDENCE_THRESHOLD),
    requiredCorroboration: Math.max(1, positiveInt(env.SI_REQUIRED_CORROBORATION, DEFAULT_REQUIRED_CORROBORATION)),
    maxCitationsPerVerdict: Math.max(1, positiveInt(env.SI_MAX_CITATIONS, 6)),
    retrievalLimit: Math.max(1, positiveInt(env.SI_RETRIEVAL_LIMIT, 8)),
    indexOnBoot: env.SI_INDEX_ON_BOOT === 'true',
  };
}

/**
 * Walk up from this file until a directory containing both `services/` and
 * `packages/` is found — the repo root, whether the service is running from
 * `src/` via ts-node or from a compiled `dist/`.
 */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'services')) && existsSync(resolve(dir, 'packages'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, '../../../..');
}

export const SI_CONFIG = 'SENTINEL_INTELLIGENCE_CONFIG';
