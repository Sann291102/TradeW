import { InstrumentRef } from './instrument-ref';
import { FeedMode, FeedStatus, FeedStatusEvent, MarketTick } from './tick';

/**
 * A push source of market data.
 *
 * Deliberately separate from `MarketDataProvider` (@tradew/types), which is a
 * *pull* contract — `getQuote`, `getCandles`, request/response. Both exist
 * because they answer different questions and have different rate economics:
 * pull is used for history and option chains (REST, hard rate caps), push is
 * used for live prices (WebSocket, effectively free per tick).
 *
 * Collapsing them into one interface would force every provider to implement
 * streaming it may not have, and would hide the fact that a `getQuote()` call
 * against Dhan costs one of only 1-per-second REST permits while a tick costs
 * nothing.
 *
 * Implementations must be safe to `start()` after `stop()`, and must never
 * throw out of a handler — an exception in a tick listener must not kill the
 * connection.
 */
export interface MarketFeed {
  /** Provider name. Written to Quote.source, so it must be stable and honest. */
  readonly name: string;
  readonly status: FeedStatus;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Idempotent — re-subscribing an already-subscribed instrument is a no-op. */
  subscribe(refs: InstrumentRef[], mode: FeedMode): Promise<void>;
  unsubscribe(refs: InstrumentRef[]): Promise<void>;

  onTick(handler: TickHandler): Unsubscribe;
  onStatus(handler: StatusHandler): Unsubscribe;
}

export type TickHandler = (tick: MarketTick) => void;
export type StatusHandler = (event: FeedStatusEvent) => void;
export type Unsubscribe = () => void;

/**
 * Minimal typed event emitter shared by feed implementations.
 *
 * Node's EventEmitter would work, but it is untyped and — more importantly —
 * rethrows listener exceptions in a way that would tear down a live feed. A
 * misbehaving consumer must never cost us the connection, so handler errors are
 * isolated here and reported through `onError` instead of propagating.
 */
export class TypedEmitter<T> {
  private handlers = new Set<(value: T) => void>();

  constructor(private readonly onError?: (err: Error) => void) {}

  on(handler: (value: T) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(value: T): void {
    for (const handler of this.handlers) {
      try {
        handler(value);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  get size(): number {
    return this.handlers.size;
  }

  clear(): void {
    this.handlers.clear();
  }
}
