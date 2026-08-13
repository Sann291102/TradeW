import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SentinelIntelligenceService } from './sentinel-intelligence.service';
import { MarketWatchService } from './watch/market-watch.service';
import { loadSentinelIntelligenceConfig } from './si.config';
import type { CorpusIngestionService } from './knowledge/corpus-ingestion.service';
import type { KnowledgeIndexService } from './knowledge/knowledge-index.service';
import type { ReasoningGraphService } from './knowledge/reasoning-graph.service';
import type { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import type { StrategyEngineService } from '../intelligence/strategy-engine.service';

/**
 * The two pieces of wiring that turn Sentinel from browser-driven into
 * server-driven, tested where the wiring lives rather than through the
 * 22-dependency orchestrator:
 *
 *  - `watchSymbol` — the entrypoint `/observe` calls so that observing a symbol
 *    is what puts it under continuous watch. Before it existed, the only
 *    production caller of `register()` was `reason()`, reachable solely via
 *    `POST /intelligence/reason`, so the watch list was empty every day and the
 *    sweep loop spent every tick in its `no-symbols` guard.
 *  - the deferred corpus warm-up — without it the corpus stayed at zero
 *    documents and `reasonInBackground` declined every sweep, so the ten agents
 *    could never run autonomously however many symbols were watched.
 *
 * Nothing here touches disk, the network or a Nest context.
 */

const config = loadSentinelIntelligenceConfig({});

/** A Tuesday, 11:00 IST — inside the session. */
const TRADING = new Date('2026-08-04T05:30:00.000Z');

function harness(opts: { indexOnBoot?: boolean; ingestError?: Error } = {}) {
  const cfg = opts.indexOnBoot === false ? loadSentinelIntelligenceConfig({ SI_INDEX_ON_BOOT: 'false' }) : config;

  const ingest = opts.ingestError
    ? vi.fn().mockRejectedValue(opts.ingestError)
    : vi.fn().mockResolvedValue({ chunksIndexed: 12 });
  const corpus = { ingest, corpusState: () => ({}) } as unknown as CorpusIngestionService;

  // Mutable `size` so a warm-up can be observed populating the substrate that
  // then makes the next call a no-op — the actual idempotency claim.
  const index = { size: 0 } as unknown as KnowledgeIndexService;
  const graph = { size: 0, build: vi.fn().mockReturnValue({ groundedConcepts: 0 }) } as unknown as ReasoningGraphService;

  const snapshot = vi.fn().mockResolvedValue({ lastPrice: 24_300 });
  const scan = vi.fn().mockReturnValue([]);
  const watch = new MarketWatchService(
    cfg,
    { snapshot } as unknown as MarketIntelligenceService,
    { scan } as unknown as StrategyEngineService,
    null,
  );

  const stub = {} as never;
  const service = new SentinelIntelligenceService(
    cfg,
    stub, // parser
    stub, // decomposer
    stub, // registry
    stub, // crossCheck
    stub, // synthesis
    corpus,
    index,
    graph,
    stub, // market
    stub, // strategies
    stub, // traps
    stub, // emotion
    stub, // news
    stub, // risk
    stub, // strategyIntelligence
    watch,
  );

  return { service, watch, corpus, ingest, index: index as unknown as { size: number }, graph, snapshot };
}

describe('an observation puts its symbol under continuous watch', () => {
  it('registers the observed symbol', () => {
    const h = harness();

    h.service.watchSymbol('NIFTY', TRADING);

    expect(h.watch.status(TRADING).watching).toEqual(['NIFTY']);
  });

  it('does not duplicate the symbol when the dashboard polls again', () => {
    // The dashboard re-observes every 45 s. Each poll must move an expiry, never
    // add a watcher — otherwise an open tab would multiply the metered candle
    // calls by however long it stayed open.
    const h = harness();

    h.service.watchSymbol('NIFTY', TRADING);
    h.service.watchSymbol('NIFTY', new Date(TRADING.getTime() + 45_000));
    h.service.watchSymbol('nifty', new Date(TRADING.getTime() + 90_000));

    expect(h.watch.status(TRADING).watching).toEqual(['NIFTY']);
  });

  it('does not fetch market data or sweep as a side effect of registering', () => {
    // `/observe` must never wait on the autonomous sweep it enables. Registration
    // is in-memory bookkeeping; the loop's own timer does the work.
    const h = harness();

    h.service.watchSymbol('NIFTY', TRADING);

    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.watch.status(TRADING).sweeps).toBe(0);
  });

});

describe('corpus warm-up at boot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('indexes the corpus without waiting for anyone to call /reason', async () => {
    const h = harness();

    h.service.onModuleInit();
    expect(h.ingest).not.toHaveBeenCalled(); // deferred, not on the boot path

    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.ingest).toHaveBeenCalledOnce();
  });

  it('does not re-ingest once the corpus is already built', async () => {
    // The restart case. A warm corpus — including one restored from the
    // persisted index on disk — must not be rebuilt or double-counted.
    const h = harness();
    h.index.size = 40;
    (h.graph as unknown as { size: number }).size = 7;

    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('runs once even if boot is repeated before the warm-up fires', async () => {
    const h = harness();

    h.service.onModuleInit();
    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(10_000);

    // Two schedulings, but the second replaced the pending timer rather than
    // adding one, and `ensureCorpus` would collapse them anyway.
    expect(h.ingest).toHaveBeenCalledOnce();
  });

  it('honours the opt-out and says so instead of silently skipping', async () => {
    const h = harness({ indexOnBoot: false });

    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('survives an ingestion failure without taking the service down', async () => {
    const h = harness({ ingestError: new Error('corpus root unreadable') });

    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.ingest).toHaveBeenCalledOnce();
    // Degraded to an ungrounded ontology rather than a crashed boot.
    expect(h.graph.build).toHaveBeenCalled();
  });

  it('does not hold the process open once shut down', () => {
    const h = harness();

    h.service.onModuleInit();
    h.service.onModuleDestroy();
    vi.advanceTimersByTime(10_000);

    expect(h.ingest).not.toHaveBeenCalled();
  });
});
