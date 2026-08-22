import type { Candle } from '@tradew/types';
import type { AgentContext, LiveBaseRate } from './agent.contract';
import type { MarketSnapshot } from '../../intelligence/market-intelligence.service';
import type { StrategyDetection } from '../../intelligence/strategy-engine.service';
import type { KnowledgeIndexService } from '../knowledge/knowledge-index.service';
import type { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type { RiskAssessment, Signal } from '../../domain';
import type {
  AgentId,
  KnowledgeCitation,
  Subtask,
  TradeLike,
  UnderstoodRequest,
} from '../types';

/**
 * Shared fixtures for the agent specs.
 *
 * Every agent is a pure function of `AgentContext`, which is the property that
 * makes them testable at all — no Nest container, no Postgres, no network, no
 * market data. This file builds that context, so each spec states only the part
 * it is actually about and a change to the context shape lands in one place
 * rather than in ten.
 *
 * The index and graph are stubs rather than the real services on purpose. The
 * real ones are covered by `knowledge-index.spec.ts`; wiring them in here would
 * make an agent's stance depend on whether a book happened to be parsed, which
 * is precisely the coupling these tests exist to rule out.
 */

/** A Tuesday, 11:00 IST — inside the session. */
export const AT = new Date('2026-08-04T05:30:00.000Z');

export function citation(sourceId = 'alpha', relevance = 0.8): KnowledgeCitation {
  return {
    chunkId: `${sourceId}:0`,
    sourceId,
    sourceTitle: `Book ${sourceId}`,
    sourcePath: `docs/Trading Books/${sourceId}.pdf`,
    sourceKind: 'book',
    locator: 'ch. 1',
    charStart: 0,
    charEnd: 100,
    quote: 'A supporting passage from the corpus.',
    relevance,
  };
}

/**
 * A corpus stub that always returns citations.
 *
 * `search`/`toCitation` are the two methods `gatherCitations` uses. Returning a
 * hit for every query is deliberate: it lets each spec assert that an agent
 * cites what it claims WITHOUT the assertion depending on retrieval quality.
 * `emptyIndex()` is the other half — no hits at all, which is what proves an
 * agent degrades to measured/derived evidence rather than emitting an uncited
 * knowledge claim.
 */
export function fullIndex(sources = ['alpha', 'beta', 'gamma']): KnowledgeIndexService {
  return {
    size: 42,
    search: (_query: string, opts: { limit?: number } = {}) =>
      sources.slice(0, opts.limit ?? 4).map((s) => ({ sourceId: s })),
    toCitation: (hit: { sourceId: string }) => citation(hit.sourceId),
  } as unknown as KnowledgeIndexService;
}

export function emptyIndex(): KnowledgeIndexService {
  return { size: 0, search: () => [], toCitation: () => citation() } as unknown as KnowledgeIndexService;
}

/**
 * An ontology stub returning fully-formed `SupportingConcept`s.
 *
 * `citations` is populated, because the learning agent branches on it: a
 * concept WITH citations becomes `knowledge()` evidence and one without becomes
 * `derived()`. A stub that left it empty would exercise only half the agent and
 * never touch the citation invariant this suite exists to pin.
 */
export function graphStub(concepts: string[] = ['liquidity_sweep', 'false_breakout']): ReasoningGraphService {
  const supporting = (conceptId: string, i: number) => ({
    conceptId,
    name: conceptId.replace(/_/g, ' '),
    relevance: `${conceptId.replace(/_/g, ' ')} bears on the current structure.`,
    weight: 0.9 - i * 0.1,
    citations: [citation(`alpha`), citation(`beta`)],
  });

  return {
    size: concepts.length,
    supportFor: (_query: string, limit = 4) => concepts.slice(0, limit).map(supporting),
    // The trap agent detects concepts from signal names, then asks for tensions
    // among them. Both are stubbed to the quiet answer — no tension — so a
    // conflict in a spec is one the spec put there.
    detect: (_text: string) => concepts.map((id) => ({ id, name: id.replace(/_/g, ' ') })),
    tensionsAmong: () => [],
    explainerFor: (conceptId: string) =>
      `${conceptId.replace(/_/g, ' ')} is a recognised structural concept. It has a second sentence.`,
    cuesFor: () => ['volume expansion on the break'],
  } as unknown as ReasoningGraphService;
}

/** An ontology with nothing in it — the cold-start / unbuilt-graph case. */
export function emptyGraph(): ReasoningGraphService {
  return {
    size: 0,
    supportFor: () => [],
    detect: () => [],
    tensionsAmong: () => [],
    explainerFor: () => null,
    cuesFor: () => [],
  } as unknown as ReasoningGraphService;
}

/**
 * A rising series of candles.
 *
 * `bars` controls length so a spec can drop below an agent's own history floor
 * and assert the abstention, which is the single most important behaviour these
 * agents have: "I have no data" must never be expressible as "I found nothing
 * wrong".
 */
export function candles(bars = 240, start = 24_000, step = 5): Candle[] {
  return Array.from({ length: bars }, (_, i) => {
    const close = start + i * step;
    return {
      timestamp: new Date(AT.getTime() - (bars - i) * 60_000).toISOString(),
      open: close - step / 2,
      high: close + step,
      low: close - step,
      close,
      volume: 100_000,
    } as unknown as Candle;
  });
}

export function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const bars = candles();
  return {
    symbol: 'NIFTY',
    lastPrice: bars[bars.length - 1].close,
    rsi14: 62,
    ema20: 24_900,
    ema50: 24_700,
    vwap: 24_950,
    macdHistogram: 12,
    cpr: { pivot: 24_800, bc: 24_750, tc: 24_850 },
    volumeVsAvg: 1.4,
    oiTrend: 'rising',
    realizedVolPct: 0.9,
    vix: 13.2,
    breadthRatio: 1.6,
    support: 24_700,
    resistance: 25_400,
    candles: bars,
    sessionCandles: bars.slice(-75),
    priorDay: bars[bars.length - 76] ?? null,
    marketProfile: {
      type: 'trending',
      description: 'One-directional session with expanding range.',
      trend: 'bullish',
      volatility: 'normal',
      structure: 'trending',
      evidence: ['higher highs and higher lows', 'volume expanding on advances', 'holding above VWAP'],
    },
    trendAnalysis: { sessionChangePct: 1.4, momentumScore: 0.72, volumeStrength: 1.4, direction: 'bullish' },
    openingRange: { high: 25_050, low: 24_950, establishedAt: AT },
    optionChain: null,
    ...over,
  } as unknown as MarketSnapshot;
}

export function detection(over: Partial<StrategyDetection> = {}): StrategyDetection {
  return {
    strategyId: 'ema-cross',
    strategyName: 'EMA cross',
    confidence: 82,
    bias: 'bullish',
    validated: true,
    rulesMatched: ['price above ema20', 'volume above average'],
    rulesUnmet: [],
    invalidationsTriggered: [],
    source: 'builtin',
    ...over,
  } as unknown as StrategyDetection;
}

export function signal(over: Partial<Signal> = {}): Signal {
  return {
    name: 'ema_trend',
    agent: 'market-technical',
    triggered: true,
    weight: 0.3,
    evidence: ['price is above both moving averages'],
    ...over,
  } as unknown as Signal;
}

export function baseRate(over: Partial<LiveBaseRate> = {}): LiveBaseRate {
  const distribution = over.distribution ?? { continued_up: 14, continued_down: 4, unclear: 2 };
  const sample = Object.values(distribution).reduce((a, b) => a + b, 0);
  return { pattern: 'ema_cross', sample, distribution, reliable: sample >= 8, ...over };
}

export function understood(over: Partial<UnderstoodRequest> = {}): UnderstoodRequest {
  return {
    rawText: 'what is NIFTY doing',
    market: { symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', hasOptionChain: true, strikeStep: 50 },
    strike: null,
    right: null,
    expiry: null,
    expiryPhrase: null,
    timeframe: '15m',
    strategyIds: [],
    indicators: [],
    style: 'intraday',
    riskProfile: 'balanced',
    intent: 'market-read',
    assumptions: [],
    parseConfidence: 0.8,
    ...over,
  } as unknown as UnderstoodRequest;
}

export function subtask(agent: AgentId, over: Partial<Subtask> = {}): Subtask {
  return {
    id: `${agent}#1`,
    agent,
    question: `what does ${agent} make of this`,
    rationale: 'fixture',
    knowledgeQueries: ['market structure'],
    informedBy: [],
    weight: 1,
    ...over,
  } as unknown as Subtask;
}

/**
 * A full agent context, with every expensive dependency stubbed.
 *
 * Defaults describe a healthy run: real candles, a validated detection, a
 * triggered signal, a populated corpus. Each spec overrides only the field it
 * is about — pass `snapshot: null` to test the no-data abstention, `index:
 * emptyIndex()` to test the uncited-claim guarantee, and so on.
 */
export function context(agent: AgentId, over: Partial<AgentContext> = {}): AgentContext {
  return {
    understood: understood(),
    subtask: subtask(agent),
    snapshot: snapshot(),
    signals: [signal()],
    detections: [detection()],
    risk: null as unknown as RiskAssessment,
    trades: [] as TradeLike[],
    account: undefined,
    baseRates: new Map(),
    index: fullIndex(),
    graph: graphStub(),
    at: AT,
    ...over,
  } as unknown as AgentContext;
}

/**
 * A front-expiry option chain read.
 *
 * The aggregates only — `entries` is what the agent walks for wall placement,
 * so it carries a handful of strikes either side of spot rather than a full
 * chain, which is enough to exercise every branch without becoming a data file.
 */
export function optionChain(over: Record<string, unknown> = {}) {
  const spot = 25_195;
  const strikes = [25_000, 25_100, 25_200, 25_300, 25_400];
  return {
    pcr: 1.18,
    maxPain: 25_200,
    callOIWall: 25_400,
    putOIWall: 25_000,
    strikesAnalysed: strikes.length,
    frontExpiry: new Date('2026-08-06T10:00:00.000Z'),
    entries: strikes.map((strike) => ({
      strike,
      callOI: strike > spot ? 900_000 : 250_000,
      putOI: strike < spot ? 850_000 : 220_000,
      callIV: 12.5,
      putIV: 13.1,
      callLtp: Math.max(1, spot - strike + 120),
      putLtp: Math.max(1, strike - spot + 120),
    })),
    ...over,
  };
}

export function riskAssessment(over: Record<string, unknown> = {}): RiskAssessment {
  return {
    overallRisk: 58,
    level: 'moderate',
    factors: [
      { name: 'volatility', score: 62, weight: 0.4, evidence: ['realized vol above its 20-day mean'] },
      { name: 'concentration', score: 51, weight: 0.3, evidence: ['margin concentrated in one underlying'] },
      { name: 'event_risk', score: 55, weight: 0.3, evidence: ['policy decision inside the holding window'] },
    ],
    assessedAt: AT.toISOString(),
    ...over,
  } as unknown as RiskAssessment;
}

/**
 * A run of trades with a widening loss streak.
 *
 * Length is above `MIN_TRADES_FOR_PATTERN` deliberately: the emotion agent
 * abstains below it, and a fixture that silently sat under the floor would make
 * every emotion assertion vacuously pass on an abstention.
 */
export function trades(count = 6): TradeLike[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    symbol: i % 3 === 0 ? 'BANKNIFTY' : 'NIFTY',
    side: i % 2 === 0 ? 'BUY' : 'SELL',
    quantity: 50 * (i + 1),
    fillPrice: 24_000 + i * 20,
    realizedPnl: i < 2 ? 400 : -600 * i,
    createdAt: new Date(AT.getTime() - (count - i) * 6 * 60_000).toISOString(),
  })) as unknown as TradeLike[];
}
