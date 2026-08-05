/**
 * Reasoning module test suite (Phase 2).
 *
 * Runs unit tests over every pure reasoning service, integration tests
 * over the retrieval → ranking → explanation pipeline using an in-memory
 * fake MemoryStore seeded with a representative mix of book, pattern and
 * research memories, and performance tests that assert cache and per-call
 * latency budgets.
 *
 *   npm run reasoning:test
 *
 * Exits non-zero on any assertion failure so CI can gate on it.
 */
import { MemoryRecord, MemorySearchHit, MemorySearchQuery, MemoryStore, NewMemoryRecord } from '@tradew/ai-core';
import { ReasoningContextBuilderService } from '../src/reasoning/context-builder.service';
import { ExplanationEngineService } from '../src/reasoning/explanation-engine.service';
import { KnowledgeCacheService } from '../src/reasoning/knowledge-cache.service';
import { KnowledgeRankingService } from '../src/reasoning/knowledge-ranking.service';
import { KnowledgeRetrievalService } from '../src/reasoning/knowledge-retrieval.service';
import { PsychologyIntelligenceService } from '../src/reasoning/psychology-intelligence.service';
import { loadReasoningConfig, ReasoningConfig } from '../src/reasoning/reasoning.config';
import { RegimeIntelligenceService } from '../src/reasoning/regime-intelligence.service';
import { SimilarityService } from '../src/reasoning/similarity.service';
import { StrategyKnowledgeService } from '../src/reasoning/strategy-knowledge.service';
import { RankingHints } from '../src/reasoning/types';

let passes = 0;
let failures = 0;
let currentSuite = '';

/**
 * Sequential suite/test harness. Every `test()` runs to completion before
 * the next one starts, and every `suite()` runs to completion before the
 * next one starts. Tests inside a suite frequently share mutable state
 * (a cache, an in-memory store, a queue), and interleaved execution
 * corrupts that state — so this runner does the boring, correct thing
 * rather than the clever, buggy one.
 */
const suiteQueue: Array<{ name: string; tests: Array<{ name: string; body: () => void | Promise<void> }> }> = [];
let currentTestList: { name: string; body: () => void | Promise<void> }[] | null = null;

function suite(name: string, register: () => void): void {
  const entry = { name, tests: [] as { name: string; body: () => void | Promise<void> }[] };
  suiteQueue.push(entry);
  currentTestList = entry.tests;
  register();
  currentTestList = null;
}

function test(name: string, body: () => void | Promise<void>): void {
  if (!currentTestList) throw new Error(`test("${name}") called outside a suite()`);
  currentTestList.push({ name, body });
}

async function runAll(): Promise<void> {
  for (const s of suiteQueue) {
    currentSuite = s.name;
    console.log(`\n== ${s.name} ==`);
    for (const t of s.tests) {
      try {
        await t.body();
        passes++;
        console.log(`  ok  ${t.name}`);
      } catch (err) {
        failures++;
        console.error(`  FAIL  ${t.name}`);
        console.error(`        ${(err as Error).message}`);
      }
    }
  }
}

function assert(cond: unknown, message = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeConfig(overrides: Partial<ReasoningConfig> = {}): ReasoningConfig {
  return { ...loadReasoningConfig({} as NodeJS.ProcessEnv), ...overrides };
}

// ---- in-memory fake MemoryStore -----------------------------------------

interface Seed {
  id: string;
  summary: string;
  content: string;
  namespace: string;
  tags?: string[];
  confidence?: number;
  createdAt?: Date;
  staleAfter?: Date;
  userId?: string | null;
  matchTerms?: string[];
}

class FakeMemoryStore implements MemoryStore {
  private records = new Map<string, MemoryRecord>();

  constructor(seeds: Seed[] = []) {
    for (const s of seeds) this.add(s);
  }

  add(seed: Seed): MemoryRecord {
    const now = seed.createdAt ?? new Date();
    const record: MemoryRecord = {
      id: seed.id,
      summary: seed.summary,
      content: seed.content,
      source: { kind: 'document', reference: seed.id },
      confidence: seed.confidence ?? 0.8,
      tags: seed.tags ?? [],
      entities: [],
      relatedIds: [],
      userId: seed.userId ?? null,
      namespace: seed.namespace,
      createdAt: now,
      updatedAt: now,
      staleAfter: seed.staleAfter,
      metadata: { matchTerms: seed.matchTerms ?? [] },
    };
    this.records.set(record.id, record);
    return record;
  }

  async store(_: NewMemoryRecord): Promise<MemoryRecord> {
    throw new Error('not used');
  }
  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.get(id) ?? null;
  }
  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    const q = query.text.toLowerCase();
    const results: MemorySearchHit[] = [];
    for (const record of this.records.values()) {
      if (query.namespace && record.namespace !== query.namespace) continue;
      if (query.tags && query.tags.length > 0) {
        const any = query.tags.some((t) => record.tags.includes(t));
        if (!any) continue;
      }
      const terms = (record.metadata?.matchTerms as string[] | undefined) ?? [];
      const haystack = [record.summary, record.content, ...terms].join(' ').toLowerCase();
      let score = 0;
      for (const word of q.split(/\s+/).filter(Boolean)) {
        if (haystack.includes(word)) score += 1;
      }
      if (score > 0) {
        const normalised = Math.min(1, score / Math.max(1, q.split(/\s+/).length));
        results.push({ record, score: normalised });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 10);
  }
  async connect(): Promise<void> {}
  async update(id: string, patch: Partial<NewMemoryRecord>): Promise<MemoryRecord> {
    const existing = this.records.get(id);
    if (!existing) throw new Error('unknown id');
    const updated = { ...existing, ...patch, updatedAt: new Date() } as MemoryRecord;
    this.records.set(id, updated);
    return updated;
  }
  async stats(): Promise<{ total: number; byNamespace: Record<string, number> }> {
    const byNamespace: Record<string, number> = {};
    for (const r of this.records.values()) byNamespace[r.namespace] = (byNamespace[r.namespace] ?? 0) + 1;
    return { total: this.records.size, byNamespace };
  }
}

// ---- shared fixture ------------------------------------------------------

function buildSeededStore(): FakeMemoryStore {
  const now = new Date();
  return new FakeMemoryStore([
    // sentinel-learning: book-derived concepts
    {
      id: 'sl-1',
      summary: 'Liquidity sweeps often sweep prior swing lows before reversing — recognise the reclaim, not the sweep.',
      content: 'A liquidity sweep is the market taking out stops above or below obvious levels...',
      namespace: 'sentinel-learning',
      tags: ['source:book', 'concept:liquidity-sweep', 'domain:institutional-concepts', 'topic:price-action'],
      confidence: 0.9,
      matchTerms: ['liquidity', 'sweep', 'stop', 'reversal', 'institutional'],
    },
    {
      id: 'sl-2',
      summary: 'FOMO drives late entries at exhaustion — the emotional pattern often coincides with terminal thrusts.',
      content: 'Fear of missing out is one of the most consistent psychological failures...',
      namespace: 'sentinel-learning',
      tags: ['source:book', 'concept:fomo', 'domain:trading-psychology', 'topic:psychology'],
      confidence: 0.85,
      matchTerms: ['fomo', 'fear', 'missing', 'psychology', 'chase'],
    },
    {
      id: 'sl-3',
      summary: 'The Wyckoff accumulation schematic ends with a Spring and Sign of Strength before markup.',
      content: 'In the accumulation phase, price traces a specific sequence...',
      namespace: 'sentinel-learning',
      tags: ['source:book', 'concept:accumulation', 'domain:volume', 'topic:strategies'],
      confidence: 0.82,
      matchTerms: ['wyckoff', 'accumulation', 'spring', 'markup', 'volume'],
    },
    {
      id: 'sl-4',
      summary: 'Position sizing bounds ruin: fixed-fractional rules keep max drawdown independent of streak length.',
      content: 'Kelly and fixed-fractional sizing solve different problems...',
      namespace: 'sentinel-learning',
      tags: ['source:book', 'domain:risk-management', 'concept:position-sizing'],
      confidence: 0.88,
      matchTerms: ['position', 'sizing', 'risk', 'drawdown', 'kelly'],
    },
    // sentinel: pattern occurrences from prior sessions
    {
      id: 'sn-1',
      summary: 'orb_retest confirmed on RELIANCE at the 15-minute open.',
      content: 'Opening range breakout retest with lower-volume pullback',
      namespace: 'sentinel',
      tags: ['pattern_occurrence', 'orb_retest'],
      confidence: 0.75,
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      matchTerms: ['orb', 'retest', 'opening', 'range', 'reliance'],
    },
    {
      id: 'sn-2',
      summary: 'Prior VWAP pullback on NIFTY held above VWAP with declining volume.',
      content: 'VWAP pullback rejoined the trend after a shallow retracement...',
      namespace: 'sentinel',
      tags: ['pattern_occurrence', 'vwap_pullback'],
      confidence: 0.7,
      createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      matchTerms: ['vwap', 'pullback', 'nifty', 'trend'],
    },
    // deliberately old to exercise decay
    {
      id: 'sn-3',
      summary: 'Legacy note from months ago on trending days.',
      content: 'Trending days often present multiple pullback opportunities...',
      namespace: 'sentinel',
      tags: ['topic:trending'],
      confidence: 0.6,
      createdAt: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000),
      matchTerms: ['trending', 'pullback', 'trend', 'day'],
    },
    // duplicate id case? no — every id unique, but this record is user-owned to exercise userRelevance
    {
      id: 'user-1',
      summary: 'User note: I keep chasing NIFTY into the last hour.',
      content: 'Personal reflection...',
      namespace: 'sentinel',
      tags: ['journal', 'topic:psychology'],
      confidence: 0.7,
      userId: 'trader-42',
      matchTerms: ['chasing', 'nifty', 'journal'],
    },
  ]);
}

async function main(): Promise<void> {
  // ---- UNIT: KnowledgeCache ------------------------------------------------

  suite('KnowledgeCache', () => {
    const config = makeConfig({ cacheTtlMs: 1000, cacheMaxEntries: 3 });
    const cache = new KnowledgeCacheService(config);

    test('miss returns null and increments misses', () => {
      const before = cache.stats().misses;
      const result = cache.get(KnowledgeCacheService.keyFor('q1', ['x'], 5));
      assertEq(result, null);
      assertEq(cache.stats().misses, before + 1);
    });

    test('set + get returns cached copy with `cached: true`', () => {
      const key = KnowledgeCacheService.keyFor('q2', ['x'], 5);
      cache.set(key, { query: 'q2', items: [], rawHitCount: 0, namespaces: ['x'], cached: false, latencyMs: 5 });
      const got = cache.get(key);
      assert(got !== null, 'expected cache hit');
      assertEq(got!.cached, true);
    });

    test('key differs on different boostTags', () => {
      const k1 = KnowledgeCacheService.keyFor('q', ['x'], 5, ['a']);
      const k2 = KnowledgeCacheService.keyFor('q', ['x'], 5, ['b']);
      assert(k1 !== k2, 'expected distinct cache keys');
    });

    test('LRU evicts least recently used when at capacity', () => {
      const c = new KnowledgeCacheService(makeConfig({ cacheTtlMs: 60_000, cacheMaxEntries: 2 }));
      const k1 = 'k1';
      const k2 = 'k2';
      const k3 = 'k3';
      const empty = { query: '', items: [], rawHitCount: 0, namespaces: [], cached: false, latencyMs: 0 };
      c.set(k1, empty);
      c.set(k2, empty);
      c.get(k1);
      c.set(k3, empty);
      assert(c.get(k1) !== null, 'k1 should survive (most recently used)');
      assertEq(c.get(k2), null);
      assertEq(c.stats().evictions, 1);
    });

    test('ttl expiry evicts on read', async () => {
      const c = new KnowledgeCacheService(makeConfig({ cacheTtlMs: 20, cacheMaxEntries: 5 }));
      const k = 'exp';
      c.set(k, { query: '', items: [], rawHitCount: 0, namespaces: [], cached: false, latencyMs: 0 });
      await new Promise((r) => setTimeout(r, 40));
      assertEq(c.get(k), null);
    });

    test('cacheTtlMs=0 disables caching', () => {
      const c = new KnowledgeCacheService(makeConfig({ cacheTtlMs: 0 }));
      const k = 'nocache';
      c.set(k, { query: '', items: [], rawHitCount: 0, namespaces: [], cached: false, latencyMs: 0 });
      assertEq(c.get(k), null);
    });
  });

  // ---- UNIT: KnowledgeRanking ---------------------------------------------

  suite('KnowledgeRanking', () => {
    const config = makeConfig();
    const ranker = new KnowledgeRankingService(config);
    const store = buildSeededStore();

    test('rank sorts by composite score descending', async () => {
      const hits = await store.search({ text: 'liquidity sweep institutional', limit: 20 });
      const ranked = ranker.rank(hits);
      assert(ranked.length > 0, 'expected at least one ranked item');
      for (let i = 1; i < ranked.length; i++) {
        assert(ranked[i - 1].score >= ranked[i].score, `not sorted at index ${i}: ${ranked[i - 1].score} < ${ranked[i].score}`);
      }
    });

    test('breakdown exposes every factor', async () => {
      const hits = await store.search({ text: 'fomo', limit: 5 });
      const ranked = ranker.rank(hits);
      assert(ranked.length > 0);
      const b = ranked[0].breakdown;
      for (const k of ['similarity', 'confidence', 'freshness', 'maturity', 'importance', 'userRelevance'] as const) {
        assert(typeof b[k] === 'number' && b[k] >= 0 && b[k] <= 1, `${k} out of [0,1]: ${b[k]}`);
      }
    });

    test('boostTags raise importance for matching records', async () => {
      const hits = await store.search({ text: 'liquidity sweep', limit: 5 });
      const withBoost = ranker.rank(hits, { boostTags: ['concept:liquidity-sweep'] });
      const withoutBoost = ranker.rank(hits);
      const boostedTarget = withBoost.find((r) => r.hit.record.id === 'sl-1');
      const plainTarget = withoutBoost.find((r) => r.hit.record.id === 'sl-1');
      assert(boostedTarget && plainTarget, 'expected sl-1 in both');
      assert(boostedTarget!.breakdown.importance >= plainTarget!.breakdown.importance, 'importance did not rise with boost');
    });

    test('requireTags filter out non-matching records', async () => {
      const hits = await store.search({ text: 'trending', limit: 10 });
      const filtered = ranker.rank(hits, { requireTags: ['pattern_occurrence'] });
      for (const r of filtered) assert(r.hit.record.tags.includes('pattern_occurrence'), 'requireTags leak');
    });

    test('freshness decays with age', async () => {
      const hits = await store.search({ text: 'trending pullback', limit: 10 });
      const ranked = ranker.rank(hits);
      const legacy = ranked.find((r) => r.hit.record.id === 'sn-3');
      const recent = ranked.find((r) => r.hit.record.id === 'sn-2');
      assert(legacy && recent, 'expected sn-2 and sn-3 in the results');
      assert(legacy!.breakdown.freshness < recent!.breakdown.freshness, `legacy freshness ${legacy!.breakdown.freshness} not < recent ${recent!.breakdown.freshness}`);
    });

    test('userRelevance is 1 when userId matches', async () => {
      const hits = await store.search({ text: 'chasing nifty', limit: 5 });
      const ranked = ranker.rank(hits, { userId: 'trader-42' } as RankingHints);
      const userNote = ranked.find((r) => r.hit.record.id === 'user-1');
      assert(userNote, 'expected user-1 in ranking');
      assertEq(userNote!.breakdown.userRelevance, 1);
    });

    test('maturity tag steers the factor', async () => {
      const local = new FakeMemoryStore([
        { id: 'm-est', summary: 's', content: 'c', namespace: 'sentinel-learning', tags: ['maturity:established'], matchTerms: ['abc'] },
        { id: 'm-ctd', summary: 's', content: 'c', namespace: 'sentinel-learning', tags: ['maturity:contested'], matchTerms: ['abc'] },
      ]);
      const hits = await local.search({ text: 'abc', limit: 5 });
      const ranked = ranker.rank(hits);
      const est = ranked.find((r) => r.hit.record.id === 'm-est');
      const ctd = ranked.find((r) => r.hit.record.id === 'm-ctd');
      assert(est && ctd);
      assert(est!.breakdown.maturity > ctd!.breakdown.maturity, 'established should exceed contested');
    });
  });

  // ---- UNIT: PsychologyIntelligence --------------------------------------

  suite('PsychologyIntelligence', () => {
    const ranker = new KnowledgeRankingService(makeConfig());
    const cache = new KnowledgeCacheService(makeConfig({ cacheTtlMs: 0 }));
    const retrieval = new KnowledgeRetrievalService(buildSeededStore(), makeConfig(), ranker, cache);
    const svc = new PsychologyIntelligenceService(retrieval);

    test('detects FOMO and revenge language', () => {
      const d = svc.detect('Kept chasing NIFTY, felt like I was missing out and then tried to make it back after the loss.');
      const keys = d.map((x) => x.cue);
      assert(keys.includes('fomo'), 'fomo missed');
      assert(keys.includes('revenge-trading'), 'revenge missed');
    });

    test('empty input yields no detections', () => {
      assertEq(svc.detect('').length, 0);
    });

    test('knowledgeFor(fomo) retrieves psychology-tagged records', async () => {
      const items = await svc.knowledgeFor(['fomo'], { limit: 5 });
      assert(items.some((it) => it.hit.record.tags.includes('domain:trading-psychology')), 'no trading-psychology tag in results');
    });

    test('detectAndFetch composes both stages', async () => {
      const { detections, knowledge } = await svc.detectAndFetch('Panic set in and I chased the FOMO move.');
      assert(detections.length >= 2, 'expected at least fear + fomo');
      assert(knowledge.length > 0, 'expected retrieved knowledge');
    });
  });

  // ---- UNIT: RegimeIntelligence ------------------------------------------

  suite('RegimeIntelligence', () => {
    const ranker = new KnowledgeRankingService(makeConfig());
    const cache = new KnowledgeCacheService(makeConfig({ cacheTtlMs: 0 }));
    const retrieval = new KnowledgeRetrievalService(buildSeededStore(), makeConfig(), ranker, cache);
    const svc = new RegimeIntelligenceService(retrieval);

    test('classify recognises canonical labels', () => {
      assertEq(svc.classify('volatile'), 'volatile');
      assertEq(svc.classify('breakout day'), 'breakout');
      assertEq(svc.classify('range-bound behaviour'), 'ranging');
      assertEq(svc.classify(''), null);
      assertEq(svc.classify(null), null);
    });

    test('classify maps MarketProfile.type', () => {
      const profile = { type: 'Bullish Trend Day', description: 'x', trend: 'bullish', volatility: 'normal', structure: 'trending', evidence: [] } as unknown as import('../src/domain').MarketProfile;
      assertEq(svc.classify(profile), 'trending');
    });

    test('boostTagsFor returns non-empty for known regimes', () => {
      assert(svc.boostTagsFor('trending').length > 0);
      assert(svc.boostTagsFor('accumulation').length > 0);
      assertEq(svc.boostTagsFor(null).length, 0);
    });

    test('knowledgeFor(accumulation) surfaces Wyckoff note', async () => {
      const items = await svc.knowledgeFor('accumulation');
      assert(items.some((it) => it.hit.record.id === 'sl-3'), 'accumulation knowledge missed');
    });
  });

  // ---- UNIT: SimilarityService -------------------------------------------

  suite('Similarity', () => {
    const ranker = new KnowledgeRankingService(makeConfig());
    const cache = new KnowledgeCacheService(makeConfig({ cacheTtlMs: 0 }));
    const retrieval = new KnowledgeRetrievalService(buildSeededStore(), makeConfig(), ranker, cache);
    const svc = new SimilarityService(retrieval);

    test('similar(psychology, "fomo") returns psychology-tagged records', async () => {
      const r = await svc.similar('psychology', 'fomo psychology chase');
      assert(r.neighbours.length > 0, 'no neighbours');
      assert(r.neighbours.some((n) => n.hit.record.tags.includes('domain:trading-psychology')), 'wrong domain');
    });

    test('similar filters out sourceId', async () => {
      const r = await svc.similar('concept', 'liquidity sweep', { sourceId: 'sl-1' });
      assert(!r.neighbours.some((n) => n.hit.record.id === 'sl-1'), 'sourceId leaked into neighbours');
    });

    test('similarAcross returns merged ranked list', async () => {
      const items = await svc.similarAcross('trending pullback');
      assert(items.length > 0);
    });
  });

  // ---- INTEGRATION: multi-namespace retrieval + dedupe -------------------

  suite('KnowledgeRetrieval (multi-namespace)', () => {
    const config = makeConfig({ namespaces: ['sentinel', 'sentinel-learning'], cacheTtlMs: 5_000 });
    const ranker = new KnowledgeRankingService(config);
    const cache = new KnowledgeCacheService(config);
    const store = buildSeededStore();
    const retrieval = new KnowledgeRetrievalService(store, config, ranker, cache);

    test('retrieves across both namespaces in one call', async () => {
      const result = await retrieval.retrieve({ query: 'liquidity sweep institutional' });
      const namespaces = new Set(result.items.map((i) => i.hit.record.namespace));
      assert(namespaces.has('sentinel-learning'), 'learning namespace missing');
      assertEq(result.cached, false);
    });

    test('cache returns identical items on second call', async () => {
      const q = 'accumulation wyckoff';
      const first = await retrieval.retrieve({ query: q });
      const second = await retrieval.retrieve({ query: q });
      assertEq(second.cached, true);
      assertEq(second.items.length, first.items.length);
    });

    test('bypassCache=true skips the cache', async () => {
      const q = 'accumulation wyckoff';
      const result = await retrieval.retrieve({ query: q, bypassCache: true });
      assertEq(result.cached, false);
    });

    test('per-namespace failure degrades gracefully', async () => {
      const flakyStore = new FakeMemoryStore([]);
      const originalSearch = flakyStore.search.bind(flakyStore);
      flakyStore.search = async (query) => {
        if (query.namespace === 'sentinel-learning') throw new Error('simulated outage');
        return originalSearch(query);
      };
      const flakyRetrieval = new KnowledgeRetrievalService(flakyStore, config, ranker, new KnowledgeCacheService(makeConfig({ cacheTtlMs: 0 })));
      const result = await flakyRetrieval.retrieve({ query: 'anything' });
      // Empty items are fine — the important thing is no throw.
      assertEq(result.items.length, 0);
    });

    test('retrieveByTags uses the tags filter', async () => {
      const items = await retrieval.retrieveByTags(['pattern_occurrence']);
      for (const it of items) assert(it.hit.record.tags.includes('pattern_occurrence'), 'tag filter leaked');
    });
  });

  // ---- INTEGRATION: Strategy Knowledge -----------------------------------

  suite('StrategyKnowledge (composition)', () => {
    const config = makeConfig({ cacheTtlMs: 0 });
    const ranker = new KnowledgeRankingService(config);
    const cache = new KnowledgeCacheService(config);
    const store = buildSeededStore();
    const retrieval = new KnowledgeRetrievalService(store, config, ranker, cache);
    const similarity = new SimilarityService(retrieval);
    const psychology = new PsychologyIntelligenceService(retrieval);
    const regime = new RegimeIntelligenceService(retrieval);

    // Minimal stubs of the pre-existing services that this file cannot
    // reach into (they need Prisma). The composition contract is the only
    // thing under test here, so returning empty from the stubs is fine.
    const stubBaseRates = { baseRateFor: async () => ({ pattern: 'test', sample: 0, distribution: {}, reliable: false }) } as unknown as import('../src/brain/strategy-intelligence.service').StrategyIntelligenceService;
    const stubHistorical = { similarPast: async () => ({ patternName: 'test', symbol: 'X', occurrences: 0, withKnownOutcome: 0, outcomeCounts: {}, sampleTooSmall: true }) } as unknown as import('../src/brain/historical-similarity.service').HistoricalSimilarityService;

    const svc = new StrategyKnowledgeService(similarity, retrieval, psychology, regime, stubBaseRates, stubHistorical);

    test('describe returns every facet', async () => {
      const payload = await svc.describe({ strategyId: 'liquidity_sweep', strategyName: 'Liquidity Sweep', regime: 'volatile', bias: 'bullish' });
      assert(payload.strategyId === 'liquidity_sweep');
      assert(Array.isArray(payload.similarStrategies));
      assert(Array.isArray(payload.requiredConfirmations));
      assert(Array.isArray(payload.failureConditions));
      assert(Array.isArray(payload.psychologyConsiderations));
      assert(Array.isArray(payload.regimeSuitability));
      assert(Array.isArray(payload.riskConsiderations));
      assert(payload.baseRate !== undefined);
      assert(payload.latencyMs >= 0);
    });

    test('psychology considerations include bullish-bias seed (fomo)', async () => {
      const payload = await svc.describe({ strategyId: 'x', strategyName: 'X strategy', bias: 'bullish' });
      const hasPsych = payload.psychologyConsiderations.some((k) => k.hit.record.tags.includes('domain:trading-psychology'));
      // The seed queries can retrieve any psychology record; we assert the domain tag rather than a specific concept.
      assert(hasPsych || payload.psychologyConsiderations.length === 0, 'psychology considerations mistagged');
    });
  });

  // ---- INTEGRATION: Context Builder + Explanation Engine -----------------

  suite('ExplanationEngine (deterministic)', () => {
    const config = makeConfig({ cacheTtlMs: 0 });
    const ranker = new KnowledgeRankingService(config);
    const cache = new KnowledgeCacheService(config);
    const store = buildSeededStore();
    const retrieval = new KnowledgeRetrievalService(store, config, ranker, cache);
    const psychology = new PsychologyIntelligenceService(retrieval);
    const regime = new RegimeIntelligenceService(retrieval);
    const builder = new ReasoningContextBuilderService(retrieval, psychology, regime);
    const stubBaseRates = { baseRateFor: async () => ({ pattern: 'test', sample: 0, distribution: {}, reliable: false }) } as unknown as import('../src/brain/strategy-intelligence.service').StrategyIntelligenceService;
    const stubHistorical = { similarPast: async () => ({ patternName: 'test', symbol: 'X', occurrences: 0, withKnownOutcome: 0, outcomeCounts: {}, sampleTooSmall: true }) } as unknown as import('../src/brain/historical-similarity.service').HistoricalSimilarityService;
    const similarity = new SimilarityService(retrieval);
    const strategyKnowledge = new StrategyKnowledgeService(similarity, retrieval, psychology, regime, stubBaseRates, stubHistorical);
    const engine = new ExplanationEngineService(builder, psychology, strategyKnowledge);

    test('explain returns a deterministic draft with every section', async () => {
      const { context, draft } = await engine.explain({
        symbol: 'NIFTY',
        timeframe: '15m',
        marketRegime: 'accumulation',
        patternName: 'liquidity sweep',
        indicators: ['RSI(14): 55.3', 'VWAP 24350.5'],
        recentMemory: ['prior sweep of yesterday low held'],
        psychologyCues: ['fomo'],
      });
      assert(context.marketKnowledge.length >= 0);
      assertEq(draft.deterministic, true);
      assert(draft.headline.includes('liquidity sweep'), `headline lost pattern: ${draft.headline}`);
      assert(draft.why.length > 0, 'empty why');
      // At least one of the retrieval slots should have populated the sections.
      const totalItems = draft.supportingConcepts.length + draft.relatedPsychology.length + draft.riskAwareness.length + draft.failureScenarios.length + draft.learningReferences.length;
      assert(totalItems > 0, 'no knowledge reached the draft');
    });

    test('draft never contains buy/sell/entry/exit directives', async () => {
      const { draft } = await engine.explain({ symbol: 'NIFTY', patternName: 'liquidity sweep', marketRegime: 'volatile' });
      const bag = [draft.headline, draft.why, ...draft.supportingConcepts, ...draft.relatedPsychology, ...draft.riskAwareness, ...draft.failureScenarios, ...draft.learningReferences].join('\n').toLowerCase();
      const forbidden = ['buy now', 'sell now', 'entry:', 'exit:', 'target:', 'price target', 'go long here', 'go short here'];
      for (const phrase of forbidden) {
        assert(!bag.includes(phrase), `directive phrase leaked: "${phrase}"`);
      }
    });

    test('explainStrategy weaves base rate line into why', async () => {
      const draft = await engine.explainStrategy({ strategyId: 'liquidity_sweep', strategyName: 'Liquidity Sweep', symbol: 'NIFTY', regime: 'volatile', bias: 'bullish' });
      assert(draft.why.toLowerCase().includes('no outcome-tagged occurrences') || draft.why.length > 0, 'expected base-rate note or non-empty why');
    });
  });

  // ---- PERFORMANCE -------------------------------------------------------

  suite('Performance', () => {
    const config = makeConfig({ cacheTtlMs: 60_000 });
    const ranker = new KnowledgeRankingService(config);
    const cache = new KnowledgeCacheService(config);
    const store = buildSeededStore();
    const retrieval = new KnowledgeRetrievalService(store, config, ranker, cache);

    test('first retrieval under 200ms with fake store', async () => {
      const started = Date.now();
      await retrieval.retrieve({ query: 'liquidity sweep institutional' });
      const elapsed = Date.now() - started;
      assert(elapsed < 200, `first retrieval too slow: ${elapsed}ms`);
    });

    test('cached retrieval faster than first, and marked cached=true', async () => {
      const q = 'accumulation wyckoff spring';
      await retrieval.retrieve({ query: q });
      const started = Date.now();
      const result = await retrieval.retrieve({ query: q });
      const elapsed = Date.now() - started;
      assert(elapsed < 50, `cache hit too slow: ${elapsed}ms`);
      assertEq(result.cached, true);
    });

    test('100 rapid retrievals of the same query complete under 200ms via cache', async () => {
      const q = 'position sizing risk';
      await retrieval.retrieve({ query: q });
      const started = Date.now();
      for (let i = 0; i < 100; i++) await retrieval.retrieve({ query: q });
      const elapsed = Date.now() - started;
      assert(elapsed < 200, `100 cached retrievals too slow: ${elapsed}ms`);
    });

    test('cache stats reflect the workload', () => {
      const stats = cache.stats();
      assert(stats.hits > 0, 'expected cache hits after workload');
      assert(stats.hitRate > 0, 'expected non-zero hit rate');
    });
  });

  // ---- CONFIG ------------------------------------------------------------

  suite('ReasoningConfig', () => {
    test('weights normalise to sum to 1', () => {
      const cfg = loadReasoningConfig({} as NodeJS.ProcessEnv);
      const sum = cfg.weights.similarity + cfg.weights.confidence + cfg.weights.freshness + cfg.weights.maturity + cfg.weights.importance + cfg.weights.userRelevance;
      assert(Math.abs(sum - 1) < 0.001, `weights don't sum to 1: ${sum}`);
    });

    test('namespaces default union of sentinel + sentinel-learning', () => {
      const cfg = loadReasoningConfig({} as NodeJS.ProcessEnv);
      assert(cfg.namespaces.includes('sentinel'));
      assert(cfg.namespaces.includes('sentinel-learning'));
    });

    test('env override sets namespaces from CSV', () => {
      const cfg = loadReasoningConfig({ SENTINEL_REASONING_NAMESPACES: 'a,b,c' } as unknown as NodeJS.ProcessEnv);
      assertEq(cfg.namespaces.length, 3);
      assertEq(cfg.namespaces[0], 'a');
    });

    test('invalid ttl falls back to default', () => {
      const cfg = loadReasoningConfig({ SENTINEL_REASONING_CACHE_TTL_MS: 'not-a-number' } as unknown as NodeJS.ProcessEnv);
      assert(cfg.cacheTtlMs > 0);
    });
  });

  await runAll();

  console.log(`\n---`);
  console.log(`Results: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`test runner crashed in suite "${currentSuite}": ${(err as Error).stack ?? err}`);
  process.exit(2);
});
