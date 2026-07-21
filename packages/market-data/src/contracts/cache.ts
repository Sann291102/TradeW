import { MarketTick } from './tick';

/**
 * Hot store for the latest tick per instrument.
 *
 * The API layer reads from here instead of recomputing on request
 * (DHAN-MARKET-DATA-INTEGRATION.md §1). The interface is deliberately tiny so
 * the in-memory implementation used today and the Redis implementation named in
 * ARCHITECTURE.md §3 are genuinely interchangeable — no method here needs
 * anything Redis cannot do atomically.
 *
 * Note the process boundary: an in-memory cache is only visible inside the
 * process that owns it. It is therefore useful *within* the ingestor (tick
 * coalescing, change detection) but cannot serve services/api across a process
 * boundary. Until Redis is wired, the API reads persisted Quote rows — which is
 * still a pure read, just a slightly staler one.
 */
export interface QuoteCache {
  readonly name: string;
  get(key: string): Promise<MarketTick | null>;
  getMany(keys: string[]): Promise<Map<string, MarketTick>>;
  set(key: string, tick: MarketTick): Promise<void>;
  /** Bulk write — one round trip per batch once this is Redis-backed. */
  setMany(entries: Array<[string, MarketTick]>): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}
