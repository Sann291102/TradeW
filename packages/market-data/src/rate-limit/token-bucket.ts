/**
 * Token bucket for Dhan's REST rate limits.
 *
 * These caps are the defining constraint of the whole integration
 * (DHAN-MARKET-DATA-INTEGRATION.md §2, §6), so they are encoded once here
 * rather than being re-derived at each call site:
 *
 *   · Market Quote  — 1 request/second
 *   · Option Chain  — 1 request per 3 seconds
 *   · Data APIs     — 5 requests/second
 *
 * `acquire()` waits rather than throwing, because every caller in this codebase
 * wants the call to happen slightly later, not to fail. Callers that genuinely
 * cannot wait should use `tryAcquire()`.
 */
export interface TokenBucketOptions {
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
  name?: string;
  now?: () => number;
}

export class TokenBucket {
  readonly name: string;
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.name = options.name ?? 'token-bucket';
    this.now = options.now ?? (() => Date.now());
    this.tokens = options.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSec = (nowMs - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefill = nowMs;
  }

  /** Consume a token if one is free. Never waits. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until the next token is available; 0 when one is free now. */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Consume a token, waiting as long as necessary. */
  async acquire(): Promise<void> {
    for (;;) {
      if (this.tryAcquire()) return;
      const wait = this.waitMs();
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wait)));
    }
  }
}

/** Buckets matching Dhan's published limits. */
export const DHAN_LIMITS = {
  marketQuote: () => new TokenBucket({ capacity: 1, refillPerSecond: 1, name: 'dhan:market-quote' }),
  optionChain: () => new TokenBucket({ capacity: 1, refillPerSecond: 1 / 3, name: 'dhan:option-chain' }),
  dataApi: () => new TokenBucket({ capacity: 5, refillPerSecond: 5, name: 'dhan:data-api' }),
} as const;
