import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { REASONING_CONFIG, ReasoningConfig } from './reasoning.config';
import { CacheStats, RetrievalResult } from './types';

interface Entry {
  value: RetrievalResult;
  expiresAt: number;
  /** LRU touch counter — smaller = older. */
  tick: number;
}

/**
 * Bounded, TTL-scoped, LRU-evicted cache for retrieval results.
 *
 * The cache is scoped by (query, namespaces, limit, boostTags) so a
 * different ranking-hint set never returns another caller's rank. Values
 * are shallow-copied on read so a downstream mutation cannot corrupt the
 * cached record. Not a general-purpose cache — deliberately narrow to
 * runtime retrieval and easy to audit.
 */
@Injectable()
export class KnowledgeCacheService {
  private readonly entries = new Map<string, Entry>();
  private tickCounter = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(@Inject(REASONING_CONFIG) private readonly config: ReasoningConfig) {}

  static keyFor(query: string, namespaces: string[], limit: number, boostTags: string[] = []): string {
    const normalisedNs = [...namespaces].sort().join(',');
    const normalisedBoost = [...boostTags].sort().join(',');
    return createHash('sha1')
      .update(`${query.trim().toLowerCase()}|${normalisedNs}|${limit}|${normalisedBoost}`)
      .digest('hex');
  }

  get(key: string): RetrievalResult | null {
    if (this.config.cacheTtlMs === 0) return null;
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }
    entry.tick = ++this.tickCounter;
    this.hits++;
    return { ...entry.value, cached: true, items: entry.value.items.slice() };
  }

  set(key: string, value: RetrievalResult): void {
    if (this.config.cacheTtlMs === 0) return;
    if (this.entries.size >= this.config.cacheMaxEntries) this.evictOldest();
    this.entries.set(key, {
      value: { ...value, cached: false, items: value.items.slice() },
      expiresAt: Date.now() + this.config.cacheTtlMs,
      tick: ++this.tickCounter,
    });
  }

  invalidate(): number {
    const size = this.entries.size;
    this.entries.clear();
    return size;
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTick = Infinity;
    for (const [k, e] of this.entries) {
      if (e.tick < oldestTick) {
        oldestTick = e.tick;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      this.entries.delete(oldestKey);
      this.evictions++;
    }
  }
}
