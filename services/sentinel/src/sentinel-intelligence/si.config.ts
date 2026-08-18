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
  /**
   * Require live-market performance behind a directional read before its
   * confidence counts. On by default; `SI_REQUIRE_LIVE_PERFORMANCE=false`
   * disables it for a cold database or an isolated test.
   */
  requireLivePerformance: boolean;
  /** Max citations attached to any single verdict. */
  maxCitationsPerVerdict: number;
  /** Retrieval fan-out per knowledge query. */
  retrievalLimit: number;
  /**
   * Warm the corpus at boot, in the background. On by default;
   * `SI_INDEX_ON_BOOT=false` leaves the corpus to be built by the first
   * `/reason`. See `SentinelIntelligenceService.scheduleCorpusWarmup` for why
   * this is deferred rather than awaited during the lifecycle hook — the "I/O
   * heavy" concern this flag was originally created for is real, and is
   * answered by running off the boot path rather than by not running.
   */
  indexOnBoot: boolean;
  /** Run the continuous market watch. `SI_WATCH_ENABLED=false` disables it. */
  watchEnabled: boolean;
  /** Milliseconds between watch sweeps. */
  watchIntervalMs: number;
  /** Hard cap on symbols under watch at once. */
  watchMaxSymbols: number;
  /** How long a symbol stays watched after the last request that touched it. */
  watchTtlMs: number;
  /**
   * Hold a watch to the end of the trading session rather than only for
   * `watchTtlMs` past the last request. On by default;
   * `SI_WATCH_PERSIST_SESSION=false` restores pure-TTL behaviour.
   */
  watchPersistThroughSession: boolean;
  /** Minimum gap before the same symbol+pattern may be recorded again. */
  watchRecordCooldownMs: number;
  /** Run the full reasoning pipeline when the watch finds a new setup. */
  watchReasonEnabled: boolean;
  /** Most symbols one sweep may reason about, so a sweep cannot overrun. */
  watchMaxReasoningPerSweep: number;
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

/**
 * A directional read makes an implicit claim that a book-learned setup is
 * working. Confidence alone cannot support that claim — the setup has to have
 * been observed resolving in a live market enough times to mean anything, and
 * the Brain's own base-rate floor (`StrategyIntelligenceService.MIN_SAMPLE`)
 * already fixes where "enough" starts. Risk-elevated readings are deliberately
 * exempt; see the gate in `synthesis.service.ts`.
 */
export const DEFAULT_REQUIRE_LIVE_PERFORMANCE = true;

/**
 * Watch cadence, floored at the bridge's own candle cache TTL (60 s).
 *
 * Sweeping faster than that cache buys nothing — `/candles` would return the
 * identical cached body — while still costing a round trip per symbol. Slower
 * is a legitimate cost/latency trade; faster is only waste.
 */
const DEFAULT_WATCH_INTERVAL_MS = 60_000;

/**
 * Symbol cap. Each watched symbol costs two `/candles` calls per sweep against
 * Dhan's 5 req/s Data-API ceiling, so twelve is a full sweep well inside the
 * limit even when every cache entry is cold.
 */
const DEFAULT_WATCH_MAX_SYMBOLS = 12;

/**
 * Floor on how long a watch survives with nobody asking about the symbol.
 *
 * With `watchPersistThroughSession` on — the default — this is only the floor
 * that applies outside the session; inside it, a watch runs to the close. See
 * `MarketWatchService.expiryFor`.
 */
const DEFAULT_WATCH_TTL_MS = 30 * 60_000;

/**
 * Re-record cooldown per symbol+pattern, matched to
 * `OutcomeLearningService.MIN_AGE_MS` (15 min) so a pattern is only counted
 * again once the previous occurrence is old enough to have been outcome-tagged.
 * See the rationale on `MarketWatchService.claimCooldown`.
 */
const DEFAULT_WATCH_RECORD_COOLDOWN_MS = 15 * 60_000;

/**
 * Reasoning runs per sweep.
 *
 * The pipeline is fully deterministic — no LLM on any path — so a run costs
 * CPU and an in-memory BM25 retrieval, and reusing the sweep's snapshot means
 * it costs no metered HTTP at all. Three is therefore a latency bound, not a
 * spend bound: it keeps a sweep where every symbol fires at once from
 * overrunning its own interval. Deferred symbols are logged and retried.
 */
const DEFAULT_WATCH_MAX_REASONING_PER_SWEEP = 3;

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
    // Opt-out rather than opt-in: an unset or malformed value must leave the
    // gate ON, so a config typo cannot quietly restore ungrounded surfacing.
    requireLivePerformance: env.SI_REQUIRE_LIVE_PERFORMANCE === 'false' ? false : DEFAULT_REQUIRE_LIVE_PERFORMANCE,
    maxCitationsPerVerdict: Math.max(1, positiveInt(env.SI_MAX_CITATIONS, 6)),
    retrievalLimit: Math.max(1, positiveInt(env.SI_RETRIEVAL_LIMIT, 8)),
    // Opt-out, not opt-in. As an opt-in it was never set anywhere and — worse —
    // never read by any code either, so the corpus stayed at zero documents
    // until somebody called `/intelligence/reason` by hand, and the background
    // watch declined to reason for exactly as long. The original "indexing is
    // I/O heavy" reason still holds and is honoured by deferring the run off
    // the boot path, not by leaving the corpus empty.
    indexOnBoot: env.SI_INDEX_ON_BOOT === 'false' ? false : true,
    // On by default, but self-limiting: the loop is a no-op with no registered
    // symbols and outside trading hours, so an idle or dev instance that
    // nobody has opened a board on never touches the metered API.
    watchEnabled: env.SI_WATCH_ENABLED === 'false' ? false : true,
    watchIntervalMs: Math.max(
      DEFAULT_WATCH_INTERVAL_MS,
      positiveInt(env.SI_WATCH_INTERVAL_MS, DEFAULT_WATCH_INTERVAL_MS),
    ),
    watchMaxSymbols: Math.max(1, positiveInt(env.SI_WATCH_MAX_SYMBOLS, DEFAULT_WATCH_MAX_SYMBOLS)),
    watchTtlMs: Math.max(60_000, positiveInt(env.SI_WATCH_TTL_MS, DEFAULT_WATCH_TTL_MS)),
    // Opt-out for the same reason `watchEnabled` is: a config typo must not
    // quietly hand the heartbeat back to the browser.
    watchPersistThroughSession: env.SI_WATCH_PERSIST_SESSION === 'false' ? false : true,
    watchRecordCooldownMs: positiveInt(env.SI_WATCH_RECORD_COOLDOWN_MS, DEFAULT_WATCH_RECORD_COOLDOWN_MS),
    watchReasonEnabled: env.SI_WATCH_REASON_ENABLED === 'false' ? false : true,
    watchMaxReasoningPerSweep: Math.max(
      1,
      positiveInt(env.SI_WATCH_MAX_REASONING_PER_SWEEP, DEFAULT_WATCH_MAX_REASONING_PER_SWEEP),
    ),
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
