/**
 * @tradew/market-data — the shared market-data engine.
 *
 * One place for provider/feed contracts, the single simulated market, the Dhan
 * adapter and the ingestion primitives, consumed by:
 *   · services/market-data — the ingestion runtime (writes)
 *   · services/api          — pure reads
 *   · services/sentinel     — pull-side provider for signal computation
 *
 * It exists to resolve the duplicate-simulator debt recorded in
 * MARKET-DATA-BASELINE.md §7 without duplicating business logic across three
 * services, per ARCHITECTURE.md §6's rule that shared libraries live in
 * packages/ and runtimes in services/.
 */

// calendar — which days the exchange trades. Consumed by services/api's
// discipline + settlement paths and by services/sentinel's clock, so both
// runtimes answer "is today a trading day" from ONE list.
export * from './calendar/nse-calendar';

// contracts
export * from './contracts/cache';
export * from './contracts/feed';
export * from './contracts/instrument-ref';
export * from './contracts/tick';

// providers
export * from './providers/simulated/ou-engine';
export * from './providers/simulated/simulated.provider';
export * from './providers/simulated/simulated.feed';
export * from './providers/dhan/dhan-binary-parser';
export * from './providers/dhan/dhan-scrip-master';
export * from './providers/dhan/dhan.feed';
// Binance — crypto only, public/keyless, read-only. Unlike the Dhan provider
// this needs no secret and no persistent subscription set, so it is consumed
// directly by services/api rather than through the standalone feed bridge.
export * from './providers/binance/binance.client';
// Twelve Data — foreign exchange. Dhan has no live currency contracts and
// Binance lists no fiat/fiat pair, so FX needs its own vendor; see the client's
// docstring for the evidence behind that.
export * from './providers/twelvedata/twelvedata.client';

// infrastructure
export * from './cache/in-memory-quote-cache';
export * from './rate-limit/token-bucket';
export * from './registry';
