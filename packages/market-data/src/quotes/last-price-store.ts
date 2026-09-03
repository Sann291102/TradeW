import {
  LastKnownQuote,
  MergeOptions,
  PriceObservation,
  UNKNOWN_QUOTE,
  isValidPrice,
  mergeObservation,
} from './last-price';

/**
 * The keyed home of the last valid price for every instrument.
 *
 * This is the market-data source of truth the dashboard reads through. It
 * replaces the bridge's bare `Map<string, LiveQuote>`, whose two problems were
 * structural rather than incidental:
 *
 *  · every tick REPLACED an entry wholesale, so a packet carrying nothing
 *    (which is what the exchange sends outside session hours) erased what was
 *    known instead of adding to it. Here every write goes through
 *    `mergeObservation`, which cannot regress a valid price.
 *  · it lived only in process memory, so restarting the bridge after the close
 *    — a deploy, a crash, a laptop waking up — left the whole universe blank
 *    until the next trading day. `serialize`/`hydrate` below make the last
 *    valid price outlive the process that observed it.
 *
 * Deliberately storage-agnostic: it hands out and takes back a plain JSON
 * document, and the caller decides whether that lands in a file, Redis or a
 * table. That keeps the invariant testable with no I/O at all, and keeps this
 * module honest about being a cache of observations rather than a database.
 */
export class LastPriceStore {
  private readonly quotes = new Map<string, LastKnownQuote>();

  /** Fold one observation in and return the resulting state. */
  observe(key: string, observation: PriceObservation, options?: MergeOptions): LastKnownQuote {
    const next = mergeObservation(this.quotes.get(key), observation, options);
    this.quotes.set(key, next);
    return next;
  }

  /**
   * Fill a gap without ever overwriting a live reading.
   *
   * For asynchronous backfills — the boot-time historical-bar fetch, a REST
   * snapshot — which can complete long after the websocket has moved on.
   */
  backfill(key: string, observation: PriceObservation, source: MergeOptions['source'] = 'last-session-bar'): LastKnownQuote {
    return this.observe(key, observation, { source, backfillOnly: true });
  }

  /** Current state, or `UNKNOWN_QUOTE` for an instrument never observed. Never
   *  null, so a caller cannot accidentally coalesce an absent quote to zero. */
  get(key: string): LastKnownQuote {
    return this.quotes.get(key) ?? { ...UNKNOWN_QUOTE };
  }

  has(key: string): boolean {
    return this.quotes.has(key);
  }

  /** True when this instrument has a price worth showing. */
  hasPrice(key: string): boolean {
    return isValidPrice(this.quotes.get(key)?.ltp);
  }

  keys(): string[] {
    return [...this.quotes.keys()];
  }

  entries(): Array<[string, LastKnownQuote]> {
    return [...this.quotes.entries()];
  }

  get size(): number {
    return this.quotes.size;
  }

  /**
   * A durable document of everything worth surviving a restart.
   *
   * Entries with no valid price are omitted: an unknown price is exactly as
   * unknown after a reload, and writing them out would grow the file by the
   * ~550 instruments that have never traded on this connection without
   * carrying a single fact.
   */
  serialize(): SerializedLastPrices {
    const quotes: Record<string, LastKnownQuote> = {};
    for (const [key, quote] of this.quotes) {
      if (isValidPrice(quote.ltp) || isValidPrice(quote.previousClose)) quotes[key] = quote;
    }
    return { version: LAST_PRICE_SNAPSHOT_VERSION, savedAt: new Date().toISOString(), quotes };
  }

  /**
   * Restore a serialized document.
   *
   * Merges rather than assigns, so hydration is safe at any point in the
   * lifecycle: a recovered value can only fill a gap, and a tick that beat the
   * disk read still wins. A document from an older/unknown schema version is
   * ignored outright — recovering a price under a layout we cannot vouch for is
   * worse than starting empty, which is the one honest fallback.
   */
  hydrate(document: unknown): number {
    if (!isSerialized(document)) return 0;
    let restored = 0;
    for (const [key, quote] of Object.entries(document.quotes)) {
      if (!quote || typeof quote !== 'object') continue;
      const at = typeof quote.at === 'string' ? new Date(quote.at) : new Date(document.savedAt);
      if (Number.isNaN(at.getTime())) continue;
      // Replayed as an observation rather than assigned, so every field goes
      // through the same validity gate as a live tick. A file hand-edited to
      // contain `"ltp": 0` restores nothing, which is the point.
      const existing = this.quotes.get(key);
      const next = mergeObservation(
        existing,
        {
          ltp: quote.ltp,
          previousClose: quote.previousClose,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          bid: quote.bid,
          ask: quote.ask,
          volume: quote.volume,
          at,
        },
        { source: quote.source ?? 'previous-close', backfillOnly: true },
      );
      // Preserve the recorded session: `at` is the observation instant, and for
      // a price carried across a restart the day it was TRADED is the fact that
      // matters for the next session's rollover.
      if (typeof quote.session === 'string' && next.session === null) next.session = quote.session;
      if (isValidPrice(next.ltp)) restored++;
      this.quotes.set(key, next);
    }
    return restored;
  }

  clear(): void {
    this.quotes.clear();
  }
}

export const LAST_PRICE_SNAPSHOT_VERSION = 1;

export interface SerializedLastPrices {
  version: number;
  savedAt: string;
  quotes: Record<string, LastKnownQuote>;
}

function isSerialized(value: unknown): value is SerializedLastPrices {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<SerializedLastPrices>;
  return (
    doc.version === LAST_PRICE_SNAPSHOT_VERSION &&
    typeof doc.savedAt === 'string' &&
    !!doc.quotes &&
    typeof doc.quotes === 'object'
  );
}
