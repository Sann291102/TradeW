import { QuoteCache } from '../contracts/cache';
import { MarketTick } from '../contracts/tick';

/**
 * Process-local `QuoteCache`.
 *
 * Used inside the ingestor for tick coalescing and change detection. It is not
 * visible across process boundaries, so it deliberately does NOT serve
 * services/api — that reads persisted Quote rows until the Redis
 * implementation named in ARCHITECTURE.md §3 exists. Keeping that limitation
 * explicit here prevents someone wiring the API to an in-memory cache that
 * would be permanently empty in a separate process.
 */
export class InMemoryQuoteCache implements QuoteCache {
  readonly name = 'in-memory';
  private readonly store = new Map<string, MarketTick>();

  async get(key: string): Promise<MarketTick | null> {
    return this.store.get(key) ?? null;
  }

  async getMany(keys: string[]): Promise<Map<string, MarketTick>> {
    const out = new Map<string, MarketTick>();
    for (const key of keys) {
      const value = this.store.get(key);
      if (value) out.set(key, value);
    }
    return out;
  }

  async set(key: string, tick: MarketTick): Promise<void> {
    this.store.set(key, tick);
  }

  async setMany(entries: Array<[string, MarketTick]>): Promise<void> {
    for (const [key, tick] of entries) this.store.set(key, tick);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async size(): Promise<number> {
    return this.store.size;
  }

  /** Synchronous snapshot for health endpoints. Not part of the interface. */
  snapshot(): MarketTick[] {
    return [...this.store.values()];
  }
}
