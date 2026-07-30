/**
 * Env-driven configuration for the runtime Reasoning module.
 *
 * Every knob is env-overridable so operators can rebalance the ranking
 * factors, extend the searched namespaces (e.g. add a per-user namespace),
 * or tune the cache without a code change. Defaults are chosen to make the
 * Brain knowledge-driven out of the box against both the pre-Phase-1
 * `sentinel` namespace (pattern occurrences, research, prior explanations)
 * and the new `sentinel-learning` namespace (book-derived concepts).
 */
export interface ReasoningConfig {
  /**
   * Namespaces the retriever queries in parallel. The default set is the
   * exact union of what pre-Phase-1 Brain services write to (`sentinel`)
   * and what the Learning module writes to (`sentinel-learning`). Adding
   * a namespace here immediately makes it available to every reasoning
   * service without any per-service change.
   */
  namespaces: string[];
  /** Cache TTL in milliseconds. 0 disables caching. */
  cacheTtlMs: number;
  /** Max entries in the LRU cache. */
  cacheMaxEntries: number;
  /** Weights for the six ranking factors — normalised to sum to 1 at load time. */
  weights: {
    similarity: number;
    confidence: number;
    freshness: number;
    maturity: number;
    importance: number;
    userRelevance: number;
  };
  /** Default limit applied to every retrieval unless the caller overrides. */
  defaultLimit: number;
  /**
   * Reference half-life (ms) for the freshness factor. A record `halfLifeMs`
   * old scores 0.5 on freshness. `staleAfter` overrides this per-record.
   */
  freshnessHalfLifeMs: number;
  /** Cap on records considered per-namespace to bound per-retrieval cost. */
  perNamespaceLimit: number;
}

export const REASONING_CONFIG = 'REASONING_CONFIG';

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function positiveFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function normaliseWeights(w: ReasoningConfig['weights']): ReasoningConfig['weights'] {
  const total =
    w.similarity + w.confidence + w.freshness + w.maturity + w.importance + w.userRelevance;
  if (total <= 0) return { similarity: 1, confidence: 0, freshness: 0, maturity: 0, importance: 0, userRelevance: 0 };
  return {
    similarity: w.similarity / total,
    confidence: w.confidence / total,
    freshness: w.freshness / total,
    maturity: w.maturity / total,
    importance: w.importance / total,
    userRelevance: w.userRelevance / total,
  };
}

const DEFAULT_NAMESPACES = ['sentinel', 'sentinel-learning'];

const DEFAULT_WEIGHTS: ReasoningConfig['weights'] = {
  similarity: 0.35,
  confidence: 0.15,
  freshness: 0.15,
  maturity: 0.1,
  importance: 0.15,
  userRelevance: 0.1,
};

export function loadReasoningConfig(env: NodeJS.ProcessEnv = process.env): ReasoningConfig {
  const nsRaw = env.SENTINEL_REASONING_NAMESPACES;
  const namespaces = nsRaw && nsRaw.trim().length > 0
    ? nsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_NAMESPACES;

  const weights: ReasoningConfig['weights'] = {
    similarity: positiveFloat(env.SENTINEL_RANK_W_SIMILARITY, DEFAULT_WEIGHTS.similarity),
    confidence: positiveFloat(env.SENTINEL_RANK_W_CONFIDENCE, DEFAULT_WEIGHTS.confidence),
    freshness: positiveFloat(env.SENTINEL_RANK_W_FRESHNESS, DEFAULT_WEIGHTS.freshness),
    maturity: positiveFloat(env.SENTINEL_RANK_W_MATURITY, DEFAULT_WEIGHTS.maturity),
    importance: positiveFloat(env.SENTINEL_RANK_W_IMPORTANCE, DEFAULT_WEIGHTS.importance),
    userRelevance: positiveFloat(env.SENTINEL_RANK_W_USER_RELEVANCE, DEFAULT_WEIGHTS.userRelevance),
  };

  return {
    namespaces,
    cacheTtlMs: positiveInt(env.SENTINEL_REASONING_CACHE_TTL_MS, 60_000),
    cacheMaxEntries: Math.max(16, positiveInt(env.SENTINEL_REASONING_CACHE_MAX, 500)),
    weights: normaliseWeights(weights),
    defaultLimit: Math.max(1, positiveInt(env.SENTINEL_REASONING_LIMIT, 8)),
    freshnessHalfLifeMs: Math.max(60_000, positiveInt(env.SENTINEL_REASONING_HALF_LIFE_MS, 7 * 24 * 60 * 60 * 1000)),
    perNamespaceLimit: Math.max(1, positiveInt(env.SENTINEL_REASONING_PER_NS_LIMIT, 20)),
  };
}
