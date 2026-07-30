import { Injectable } from '@nestjs/common';

interface Entry<T> {
  value: T;
  at: number;
}

/**
 * Lesson/quiz/flashcard cache.
 *
 * Generation is deterministic and cheap, but the spec asks lessons be cached,
 * and caching also guarantees a lesson's quiz/flashcards stay consistent with
 * the exact lesson a learner is viewing within a session. Keyed by the
 * generated artifact's id; cleared wholesale when the knowledge base is
 * refreshed (admin "Refresh Knowledge"), because a reload can change concept
 * content and every derived artifact with it.
 */
@Injectable()
export class LessonCacheService {
  private readonly store = new Map<string, Entry<unknown>>();
  private hits = 0;
  private misses = 0;
  private static readonly MAX = 2000;

  getOrCompute<T>(key: string, compute: () => T): T {
    const existing = this.store.get(key);
    if (existing) {
      this.hits++;
      return existing.value as T;
    }
    this.misses++;
    const value = compute();
    // Never cache a null/undefined result — an unknown id should retry, not
    // pin a miss.
    if (value != null) {
      if (this.store.size >= LessonCacheService.MAX) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      this.store.set(key, { value, at: Date.now() });
    }
    return value;
  }

  invalidateAll(): number {
    const n = this.store.size;
    this.store.clear();
    return n;
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.store.size, hits: this.hits, misses: this.misses };
  }
}
