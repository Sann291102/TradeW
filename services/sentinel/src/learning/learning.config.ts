import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Environment-driven configuration for the Learning module.
 *
 * Every knob is env-overridable so operators can rebind the books folder, the
 * ingestion namespace, chunk sizes, and worker cadence without a code change.
 * Defaults are chosen to work out-of-the-box against
 * `docs/Trading Books/` and the existing Brain.
 */
export interface LearningConfig {
  /** Absolute path to the books directory that is scanned for source material. */
  booksDir: string;
  /** Absolute path to the file where ingestion job state is persisted. */
  stateFile: string;
  /** Namespace tag used on every MemoryRecord written by this module. */
  namespace: string;
  /** Target character count per chunk (approximate tokens = chars/4). */
  chunkChars: number;
  /** Character overlap between chunks so cross-chunk context is not lost. */
  chunkOverlapChars: number;
  /** Maximum concurrent ingestion jobs run by the queue. */
  maxConcurrentJobs: number;
  /** Interval (ms) at which the background worker polls the queue for pending jobs. */
  workerIntervalMs: number;
  /** Interval (ms) at which the auto-scanner rechecks the books folder for new files. `0` disables auto-scan. */
  autoScanIntervalMs: number;
  /** Cap on chunks per ingestion job to bound cost per book — 0 removes the cap. */
  maxChunksPerJob: number;
  /** Minimum characters in a chunk before it is considered worth embedding. */
  minChunkChars: number;
}

const DEFAULT_CHUNK_CHARS = 3200;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MIN_CHUNK_CHARS = 400;
const DEFAULT_WORKER_INTERVAL_MS = 5_000;

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function loadLearningConfig(env: NodeJS.ProcessEnv = process.env): LearningConfig {
  const booksDir = resolve(env.SENTINEL_BOOKS_DIR || defaultBooksDir());
  const stateFile = resolve(env.SENTINEL_LEARNING_STATE_FILE || defaultStateFile());

  return {
    booksDir,
    stateFile,
    namespace: env.SENTINEL_LEARNING_NAMESPACE || 'sentinel-learning',
    chunkChars: positiveInt(env.SENTINEL_LEARNING_CHUNK_CHARS, DEFAULT_CHUNK_CHARS),
    chunkOverlapChars: positiveInt(env.SENTINEL_LEARNING_CHUNK_OVERLAP, DEFAULT_CHUNK_OVERLAP),
    maxConcurrentJobs: Math.max(1, positiveInt(env.SENTINEL_LEARNING_MAX_CONCURRENT, 1)),
    workerIntervalMs: positiveInt(env.SENTINEL_LEARNING_WORKER_INTERVAL_MS, DEFAULT_WORKER_INTERVAL_MS),
    autoScanIntervalMs: positiveInt(env.SENTINEL_LEARNING_AUTOSCAN_INTERVAL_MS, 0),
    maxChunksPerJob: positiveInt(env.SENTINEL_LEARNING_MAX_CHUNKS, 0),
    minChunkChars: positiveInt(env.SENTINEL_LEARNING_MIN_CHUNK_CHARS, DEFAULT_MIN_CHUNK_CHARS),
  };
}

/**
 * Best-effort default: walk up from this file until we find `docs/Trading Books`.
 * The service can then be run from the repo root, from `services/sentinel/`,
 * or from a compiled `dist/` directory without an env var.
 */
function defaultBooksDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'docs', 'Trading Books');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, '../../../../docs/Trading Books');
}

function defaultStateFile(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'services', 'sentinel');
    if (existsSync(candidate)) return resolve(candidate, 'data', 'learning-state.json');
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, '../../data/learning-state.json');
}

export const LEARNING_CONFIG = 'LEARNING_CONFIG';
