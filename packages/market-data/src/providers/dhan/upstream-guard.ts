/**
 * The thing that stops one upstream fault becoming N upstream faults.
 *
 * ── THE MEASUREMENT THIS IS BUILT FROM ─────────────────────────────────────
 *
 * Taken against the running bridge on 2026-08-17, while its Dhan credential was
 * dead. `/candles?symbol=NIFTY&interval=15m&days=5`, the exact call every
 * Sentinel observation makes:
 *
 *   baseline (in-memory route)        ~2 ms
 *   8x sequential, identical          57, 30, 28, 32, 30, 27, 28, 29 ms
 *   50 concurrent, identical          wall 621 ms; immediate repeat still 30 ms
 *
 * Every number above the 2 ms baseline is a round trip to Dhan. So:
 *
 *   · A FAILED READ WAS NEVER CACHED. Eight identical requests for the same
 *     symbol/interval/window made eight upstream calls. `candleCache.set` ran
 *     only on the success path, so the one situation that most needs damping —
 *     a broken upstream — was the one situation with no damping at all.
 *
 *   · IDENTICAL CONCURRENT READS DID NOT COALESCE. Fifty concurrent requests
 *     made fifty upstream calls, and the repeat straight afterwards made a
 *     fifty-first. `/optionchain` had `optionChainInFlight` for exactly this
 *     reason; `/candles` never got it, even though it is the hotter route.
 *
 * The arithmetic that follows is why this is a reliability bug and not an
 * inefficiency. One observation reads 4 metered series (15m + 1d underlying,
 * CE + PE legs). The workspace polls every 10 s with an active watch:
 *
 *   1 user   →  4 series / 10 s            =   0.4 calls/s
 *   100 users → 400 series / 10 s          =  40   calls/s
 *
 * against Dhan's documented 5 req/s. So ~13 concurrent users saturate the Data
 * API, and past that every user's read fails — which, because failures were
 * uncached, produced MORE calls rather than fewer. That is a positive feedback
 * loop: the system's response to being over its rate limit was to exceed it
 * further. It cannot be fixed by tuning a poll interval, only by making a
 * failure cost less than a success.
 *
 * ── THE THREE MECHANISMS ───────────────────────────────────────────────────
 *
 * SINGLE-FLIGHT — N concurrent callers for one key share ONE upstream call.
 *   Bounds fan-out by DISTINCT KEYS instead of by request count, so 1,000 users
 *   watching NIFTY cost exactly what one user watching NIFTY costs.
 *
 * NEGATIVE CACHE — a fault is remembered briefly (see `FAULT_CACHE_MS`). Not to
 *   serve stale data: `get` re-throws the SAME typed fault, so the caller's
 *   error handling is unchanged. Only to stop the retry arriving upstream.
 *
 * BREAKER — while the credential is known-dead, nothing is attempted at all.
 *   This is the one that collapses the storm to zero: an auth fault is not
 *   per-key, it is per-process, so damping it per-key would still admit one call
 *   per symbol per window. `isOpen` is supplied by the caller because only the
 *   caller knows what "dead" means for its credential.
 */

import { DhanUpstreamError, FAULT_CACHE_MS } from './dhan-fault';

interface Entry<T> {
  /** A settled good value and when it landed. */
  value?: { at: number; data: T };
  /** A settled fault and when it landed. */
  fault?: { at: number; error: DhanUpstreamError; until: number };
  /** The shared in-flight call, if any. */
  inFlight?: Promise<T>;
}

export interface UpstreamGuardOptions {
  /** How long a GOOD value may be reused. Per-guard, since it is per-endpoint. */
  ttlMs: number;
  /**
   * True while the process-wide credential is known-bad. When open, `get`
   * rejects immediately without invoking `fn` — the difference between 0
   * upstream calls and one-per-key.
   */
  isOpen?: () => DhanUpstreamError | null;
  /** Hard cap on retained keys, so an unbounded symbol space cannot leak. */
  maxEntries?: number;
  now?: () => number;
}

export class UpstreamGuard<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly isOpen: () => DhanUpstreamError | null;

  /** Counters, for `/status` and for the tests that assert the bounding works. */
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private faultsServed = 0;
  private breakerRejections = 0;

  constructor(options: UpstreamGuardOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 2_000;
    this.now = options.now ?? Date.now;
    this.isOpen = options.isOpen ?? (() => null);
  }

  /**
   * The guarded read. `fn` is invoked at most once per key per TTL window, and
   * never at all while the breaker is open.
   *
   * Throws `DhanUpstreamError` for a fault — including one replayed from the
   * negative cache, so a caller cannot tell (and must not care) whether it was
   * the request that discovered the fault.
   */
  async get(key: string, fn: () => Promise<T>): Promise<T> {
    const open = this.isOpen();
    if (open) {
      this.breakerRejections++;
      throw open;
    }

    const entry = this.entries.get(key);
    const now = this.now();

    if (entry?.value && now - entry.value.at < this.ttlMs) {
      this.hits++;
      return entry.value.data;
    }
    if (entry?.fault && now < entry.fault.until) {
      this.faultsServed++;
      throw entry.fault.error;
    }
    if (entry?.inFlight) {
      this.coalesced++;
      return entry.inFlight;
    }

    this.misses++;
    const slot: Entry<T> = entry ?? {};
    // Keep a settled value while a refresh runs, so a concurrent reader is
    // served the previous good value rather than being made to wait.
    const inFlight = (async () => {
      try {
        const data = await fn();
        slot.value = { at: this.now(), data };
        slot.fault = undefined;
        return data;
      } catch (err) {
        if (err instanceof DhanUpstreamError) {
          slot.fault = {
            at: this.now(),
            error: err,
            until: this.now() + FAULT_CACHE_MS[err.kind],
          };
        }
        throw err;
      } finally {
        slot.inFlight = undefined;
      }
    })();

    slot.inFlight = inFlight;
    this.entries.set(key, slot);
    this.evict();
    return inFlight;
  }

  /**
   * The last good value for a key, whatever its age.
   *
   * For callers whose UI must not blank out: an option chain that fails to
   * refresh should keep rendering its previous strikes, because an empty table
   * reads as "the market stopped". Separate from `get` on purpose — serving
   * stale data is a per-endpoint product decision, never a default.
   */
  lastGood(key: string): T | undefined {
    return this.entries.get(key)?.value?.data;
  }

  /** Drop every negative-cache entry. Called when the credential is renewed —
   *  faults recorded against the dead token say nothing about the new one. */
  clearFaults(): void {
    for (const entry of this.entries.values()) entry.fault = undefined;
  }

  stats() {
    return {
      keys: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      faultsServed: this.faultsServed,
      breakerRejections: this.breakerRejections,
    };
  }

  /** Oldest-first eviction. Map preserves insertion order. */
  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
