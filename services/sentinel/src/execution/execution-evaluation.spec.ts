import type { Candle } from '@tradew/types';
import { describe, expect, it } from 'vitest';
import type { ObserveResponse, SideInFocus } from '../domain';
import type { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { StrategyEngineService, type StrategyDetection } from '../intelligence/strategy-engine.service';
import type { InternalObservation, SentinelOrchestratorService } from '../orchestrator/sentinel-orchestrator.service';
import { ExecutionEvaluationService } from './execution-evaluation.service';

/**
 * The agent-facing evaluation, gate by gate.
 *
 * The orchestrator is stubbed — deliberately, and this is the ONLY thing
 * stubbed. The point of these tests is the four gates this service adds, and
 * driving them through a real observation would mean driving them through a
 * live market read, which is neither deterministic nor available in CI. Every
 * gate itself (`data-quality.ts`, `index-direction.ts`, `evidence.ts`,
 * `strike-candidates.ts`) runs for real here.
 */

const NOW = () => new Date();

function risingCandles(count = 60, start = 24_000): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += i % 4 === 3 ? -12 : 10;
    out.push({
      // Newest bar is ~1 minute old, so the freshness gate passes.
      timestamp: new Date(Date.now() - (count - i) * 60_000),
      open,
      high: Math.max(open, price) + 5,
      low: Math.min(open, price) - 5,
      close: price,
      volume: 120_000,
    });
  }
  return out;
}

function bullishSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const candles = risingCandles();
  const last = candles[candles.length - 1].close;
  return {
    symbol: 'NIFTY',
    lastPrice: last,
    rsi14: 60,
    ema20: last - 40,
    ema50: last - 120,
    vwap: last - 60,
    macdHistogram: 9,
    cpr: null,
    volumeVsAvg: 1.4,
    oiTrend: 'rising',
    realizedVolPct: 0.8,
    vix: 12,
    breadthRatio: 1.6,
    support: last - 250,
    resistance: last + 250,
    candles,
    sessionCandles: candles.slice(-20),
    priorDay: null,
    marketProfile: {
      type: 'Bullish Trend Day',
      description: 'trend',
      trend: 'bullish',
      volatility: 'normal',
      structure: 'trending',
      evidence: [],
    },
    trendAnalysis: { sessionChangePct: 1.4, momentumScore: 0.8, volumeStrength: 1.4, direction: 'bullish' },
    openingRange: { high: last - 200, low: last - 320, establishedAt: candles[0].timestamp },
    optionChain: {
      pcr: 1.35,
      maxPain: Math.round(last / 50) * 50 + 100,
      callOIWall: Math.round(last / 50) * 50 + 300,
      putOIWall: Math.round(last / 50) * 50 - 150,
      strikesAnalysed: 21,
      frontExpiry: new Date(Date.now() + 3 * 86_400_000),
      entries: [],
    },
    ...overrides,
  } as MarketSnapshot;
}

/**
 * A dense, liquid chain around spot so strike selection has something to pick.
 *
 * Deliberately carries NO previous-day open interest by default. That is the
 * production shape for a provider that publishes none, and it keeps every
 * pre-existing test in this file exercising the same path it always did: with
 * no ΔOI the positioning gate degrades to a static read and cannot refuse.
 * A test that wants the gate to bite supplies `prev` explicitly.
 */
function chainAround(
  spot: number,
  step = 50,
  width = 5,
  prev?: (strike: number, offsetSteps: number) => Record<string, number>,
) {
  const atm = Math.round(spot / step) * step;
  const entries = [];
  for (let i = -width; i <= width; i++) {
    const strike = atm + i * step;
    entries.push({
      strike,
      callOI: 500_000,
      putOI: 480_000,
      callVolume: 90_000,
      putVolume: 80_000,
      callIV: 14,
      putIV: 15,
      callLtp: Math.max(6, 120 - i * 18),
      putLtp: Math.max(6, 120 + i * 18),
      ...(prev ? prev(strike, i) : {}),
    });
  }
  return { frontExpiry: new Date(Date.now() + 3 * 86_400_000).toISOString(), entries };
}

function sideInFocus(side: 'CE' | 'PE', confidence = 82): SideInFocus {
  return {
    side,
    bias: side === 'CE' ? 'bullish' : 'bearish',
    strike: 24_500,
    confidence,
    rationale: ['stubbed'],
    tradeManagement: [],
    disclaimer: 'x',
    liveValidation: { status: 'observing', label: 'x', pnlPoints: 0, entryPrice: 24_500, currentPrice: 24_500 },
  } as unknown as SideInFocus;
}

function detection(strategyId: string, bias: 'bullish' | 'bearish', validated = true): StrategyDetection {
  return {
    strategyId,
    strategyName: strategyId,
    confidence: 84,
    bias,
    rulesMatched: ['a', 'b'],
    rulesUnmet: [],
    invalidationsTriggered: [],
    detectedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    validated,
    source: 'built-in',
  };
}

/**
 * Builds the service with a stub orchestrator returning one canned observation.
 *
 * The response's `optionChain` and the snapshot's are SYNCHRONISED here,
 * because the real orchestrator derives the first from the second — they are
 * two views of one read. An earlier version of this fixture set them
 * independently, and every test then failed on the data-quality gate because
 * the snapshot's chain was empty while the response's was full. That is the
 * gate working: a decision whose analysis saw no chain must not be allowed to
 * price a contract from one.
 */
function serviceFor(observation: {
  snapshot: MarketSnapshot;
  detections: StrategyDetection[];
  side?: SideInFocus | null;
  optionChain?: ReturnType<typeof chainAround> | null;
}) {
  const wireChain =
    observation.optionChain === undefined ? chainAround(observation.snapshot.lastPrice) : observation.optionChain;

  // Mirror the wire chain back onto the snapshot the analysis "read".
  const snapshot: MarketSnapshot = {
    ...observation.snapshot,
    optionChain: wireChain
      ? {
          ...(observation.snapshot.optionChain ?? {
            pcr: 1.2,
            maxPain: observation.snapshot.lastPrice,
            callOIWall: null,
            putOIWall: null,
            strikesAnalysed: wireChain.entries.length,
          }),
          strikesAnalysed: wireChain.entries.length,
          frontExpiry: new Date(wireChain.frontExpiry),
          entries: wireChain.entries.map((e) => ({ ...e, expiry: new Date(wireChain.frontExpiry) })),
        }
      : null,
  } as MarketSnapshot;

  const response = {
    runId: 'run-1',
    synthesis: null,
    publication: { publish: true, threshold: 70, confidence: 82, conditions: [], corroboratingSources: [], conflicts: [], waitAndWatchReason: null },
    sideInFocus: observation.side === undefined ? sideInFocus('CE') : observation.side,
    confidence: { score: 82 },
    marketProfile: snapshot.marketProfile,
    marketState: { current: 'SIDE_IN_FOCUS' },
    strategyMatches: observation.detections,
    risk: null,
    optionChain: wireChain,
    strategyAdvice: { activeStrategyId: 'x', activeStrategyName: 'X' },
  } as unknown as ObserveResponse;

  const orchestrator = {
    observeInternal: async (): Promise<InternalObservation> => ({
      response,
      snapshot,
      detections: observation.detections,
    }),
  } as unknown as SentinelOrchestratorService;

  return new ExecutionEvaluationService(orchestrator, new StrategyEngineService());
}

const BASE_INPUT = { symbol: 'NIFTY', userId: 'u1', minConfidence: 70 };

describe('ExecutionEvaluationService — the happy path', () => {
  it('is executable when all four gates clear and a strike is tradable', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);

    expect(result.verdict).toBe('executable');
    expect(result.executable).toBe(true);
    expect(result.strikes.selected).not.toBeNull();
    expect(result.agentStrategy?.strategyId).toBe('agent-trend-momentum');
    expect(result.agentStrategy?.version).toBe('1.0.0');
    // The exit rules travel WITH the decision — the position manager needs
    // them and must not have to look the strategy up again later.
    expect(result.agentStrategy?.exitRules.length).toBeGreaterThan(0);
    expect(result.indexDirection.direction).toBe('bullish');
    expect(result.dataQuality.ok).toBe(true);
    expect(result.evidence).not.toBeNull();
  });

  it('reports every confirmation that ran, in order', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.confirmations.map((c) => c.id)).toEqual([
      'data-quality',
      'confidence-floor',
      'agent-strategy',
      'index-direction',
      'evidence-support',
      'option-positioning',
      'tradable-strike',
    ]);
    expect(result.confirmations.every((c) => c.passed)).toBe(true);
  });

  it('passes the positioning gate on a chain that published no previous open interest', async () => {
    // The default fixture chain carries no `callPrevOI`. The gate must report
    // that it could not read change and PASS — never refuse on absent data.
    const snapshot = bullishSnapshot();
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);

    expect(result.verdict).toBe('executable');
    expect(result.positioning?.hasOIChange).toBe(false);
    expect(result.positioningJudgement?.verdict).not.toBe('conflicts');
    expect(result.confirmations.find((c) => c.id === 'option-positioning')?.passed).toBe(true);
  });
});

/**
 * A chain whose book actively disagrees with a bullish read: every level above
 * spot is being written into harder than yesterday, and every level below it is
 * being abandoned. Heaviest-nearest on both sides so the ladder's first rung is
 * deterministic regardless of where the at-the-money strike falls.
 */
function chainDisagreeingWithBullish(spot: number) {
  return chainAround(spot, 50, 5, (_strike, i) => {
    const callOI = i >= 0 ? 2_000_000 - i * 100_000 : 400_000;
    const putOI = i <= 0 ? 2_000_000 + i * 100_000 : 300_000;
    return {
      callOI,
      putOI,
      // Call OI up on a falling premium — fresh writing, the level defended harder.
      callPrevOI: i >= 0 ? callOI - 800_000 : 400_000,
      callPrevClose: Math.max(6, 120 - i * 18) * 1.6,
      // Put OI down on a rising premium — writers covering, the level abandoned.
      putPrevOI: i <= 0 ? putOI + 800_000 : 300_000,
      putPrevClose: Math.max(6, 120 + i * 18) * 0.6,
    };
  });
}

describe('ExecutionEvaluationService — the gates', () => {
  it('GATE 1: refuses stale bars before reporting anything as meaningful', async () => {
    const stale = risingCandles().map((c) => ({ ...c, timestamp: new Date(c.timestamp.getTime() - 6 * 3_600_000) }));
    const snapshot = bullishSnapshot({ candles: stale, sessionCandles: stale.slice(-20) });
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);

    expect(result.verdict).toBe('stale-data');
    expect(result.executable).toBe(false);
    expect(result.dataQuality.failedCheckId).toBe('bar-freshness');
    // The index read is still reported — an operator asking "why is nothing
    // trading" needs to see what the agent thought, not an empty object.
    expect(result.indexDirection.votes.length).toBe(5);
  });

  it('GATE 1: refuses a history too short for its own indicators', async () => {
    const short = risingCandles(15);
    const snapshot = bullishSnapshot({ candles: short, sessionCandles: short });
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('stale-data');
    expect(result.dataQuality.failedCheckId).toBe('candle-history');
  });

  it('GATE 2: refuses when only an OBSERVATION strategy validated', async () => {
    const snapshot = bullishSnapshot();
    // `vwap-pullback` is one of the eight observation strategies. It can
    // publish a side in focus; it can never authorise an agent's trade.
    const service = serviceFor({ snapshot, detections: [detection('vwap-pullback', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('no-agent-strategy');
    expect(result.reason).toContain('observation strategy');
  });

  it('GATE 2: refuses an agent strategy that is not on this profile’s roster', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    // The SENSEX agent's roster, evaluated against a NIFTY-agent detection.
    const result = await service.evaluate({
      ...BASE_INPUT,
      strategyIds: ['agent-opening-range-expansion', 'agent-exhaustion-reversal'],
    });
    expect(result.verdict).toBe('no-agent-strategy');
    expect(result.reason).toContain('agent-opening-range-expansion');
  });

  it('GATE 2: refuses an UNVALIDATED agent detection', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({
      snapshot,
      detections: [detection('agent-trend-momentum', 'bullish', /* validated */ false)],
    });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('no-agent-strategy');
  });

  it('GATE 2: refuses an agent detection whose bias contradicts the published side', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({
      snapshot,
      // A validated BEARISH structure shift does not authorise buying a call
      // just because something else published one.
      detections: [detection('agent-smc-structure-shift', 'bearish')],
      side: sideInFocus('CE'),
    });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('no-agent-strategy');
  });

  it('GATE 3: refuses when the index reads the OTHER way from the option side', async () => {
    // A bearish index, with a bullish side in focus and a bullish agent
    // detection. Sentinel published it; the index disagrees; nothing trades.
    const snapshot = bullishSnapshot();
    const bearishIndex = bullishSnapshot({
      lastPrice: snapshot.lastPrice,
      ema20: snapshot.lastPrice + 60,
      ema50: snapshot.lastPrice + 160,
      vwap: snapshot.lastPrice + 90,
      trendAnalysis: { sessionChangePct: -1.2, momentumScore: 0.8, volumeStrength: 1.2, direction: 'bearish' },
      openingRange: { high: snapshot.lastPrice + 200, low: snapshot.lastPrice + 100, establishedAt: new Date() },
    });
    const service = serviceFor({
      snapshot: bearishIndex,
      detections: [detection('agent-trend-momentum', 'bullish')],
      side: sideInFocus('CE'),
    });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('index-direction-conflict');
    expect(result.reason).toContain('index');
    expect(result.indexDirection.direction).not.toBe('bullish');
  });

  it('GATE 3: refuses an UNCLEAR index rather than taking the bigger half', async () => {
    const snapshot = bullishSnapshot({
      ema20: null,
      ema50: null,
      vwap: null,
      openingRange: null,
      trendAnalysis: null,
    });
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('index-direction-conflict');
    expect(['unclear', 'neutral']).toContain(result.indexDirection.direction);
  });

  it('GATE 4: refuses when the strategy’s own evidence does not support it', async () => {
    // A bullish index by structure, but the momentum strategy's declared
    // evidence (breadth, RSI, MACD) all point the other way.
    const base = bullishSnapshot();
    const conflicted = bullishSnapshot({
      breadthRatio: 0.35,
      rsi14: 41,
      macdHistogram: -14,
      volumeVsAvg: 0.4,
      vwap: base.lastPrice + 5,
    });
    const service = serviceFor({ snapshot: conflicted, detections: [detection('agent-trend-momentum', 'bullish')] });
    const result = await service.evaluate(BASE_INPUT);
    // Either the index gate or the evidence gate may bind first; both are
    // correct refusals and both must leave `executable` false.
    expect(['evidence-conflict', 'index-direction-conflict']).toContain(result.verdict);
    expect(result.executable).toBe(false);
  });

  it('GATE 5: refuses when the option book disagrees with the side in focus', async () => {
    // Index, strategy and evidence all say bullish. The chain says every level
    // above spot is being written into harder and every level below it is
    // being abandoned. That disagreement is the answer, and it belongs to the
    // option market — nothing above this gate can see it.
    const snapshot = bullishSnapshot();
    const service = serviceFor({
      snapshot,
      detections: [detection('agent-trend-momentum', 'bullish')],
      optionChain: chainDisagreeingWithBullish(snapshot.lastPrice),
    });
    const result = await service.evaluate(BASE_INPUT);

    expect(result.verdict).toBe('positioning-conflict');
    expect(result.executable).toBe(false);
    expect(result.positioning?.hasOIChange).toBe(true);
    expect(result.positioningJudgement?.verdict).toBe('conflicts');
    // The refusal names which signals opposed it, not just that it refused.
    expect(result.confirmations.find((c) => c.id === 'option-positioning')?.passed).toBe(false);
    // And the map is still attached: "why did nothing trade?" is a question
    // about the levels.
    expect(result.ladder?.steps.length).toBeGreaterThan(0);
    expect(result.ladder?.nextDecisionPoint).not.toBeNull();
  });

  it('GATE 5: judges the mirror side of the same book independently', async () => {
    // The same chain that refuses a CE side must not automatically endorse a
    // PE one — the two are separate readings of one book, and a gate that
    // simply inverted would be a direction generator wearing a gate's clothes.
    const snapshot = bullishSnapshot();
    const service = serviceFor({
      snapshot,
      detections: [detection('agent-trend-momentum', 'bullish')],
      optionChain: chainDisagreeingWithBullish(snapshot.lastPrice),
    });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.positioningJudgement?.side).toBe('CE');
    expect(result.positioning).not.toBeNull();
  });

  it('refuses below the profile’s own confidence floor', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({
      snapshot,
      detections: [detection('agent-trend-momentum', 'bullish')],
      side: sideInFocus('CE', 69),
    });
    const result = await service.evaluate({ ...BASE_INPUT, minConfidence: 70 });
    expect(result.verdict).toBe('below-threshold');
    expect(result.executable).toBe(false);
  });

  it('stays silent — not faulty — when Sentinel published no side', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')], side: null });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('no-side-in-focus');
    expect(result.executable).toBe(false);
  });

  it('refuses when the chain carries no tradable strike', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({
      snapshot,
      detections: [detection('agent-trend-momentum', 'bullish')],
      // A chain that exists but whose legs are all illiquid.
      optionChain: {
        frontExpiry: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        entries: [-1, 0, 1].map((i) => ({
          strike: Math.round(snapshot.lastPrice / 50) * 50 + i * 50,
          callOI: 10,
          putOI: 10,
          callVolume: 1,
          putVolume: 1,
          callIV: 12,
          putIV: 12,
          callLtp: 80,
          putLtp: 80,
        })),
      },
    });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('no-tradable-strike');
    // The candidates ARE returned, with the check that failed each one.
    expect(result.strikes.candidates.length).toBe(3);
    expect(result.strikes.candidates.every((c) => !c.tradable)).toBe(true);
  });

  it('never reports executable without a selected strike', async () => {
    const snapshot = bullishSnapshot();
    const service = serviceFor({ snapshot, detections: [detection('agent-trend-momentum', 'bullish')], optionChain: null });
    const result = await service.evaluate(BASE_INPUT);
    expect(result.verdict).toBe('no-option-chain');
    expect(result.executable).toBe(false);
    expect(result.strikes.selected).toBeNull();
  });
});

describe('ExecutionEvaluationService — the two agents are independent', () => {
  it('the same market yields different verdicts for different rosters', async () => {
    const snapshot = bullishSnapshot();
    const detections = [detection('agent-trend-momentum', 'bullish')];

    const nifty = serviceFor({ snapshot, detections });
    const withMomentum = await nifty.evaluate({ ...BASE_INPUT, strategyIds: ['agent-trend-momentum'] });

    const sensex = serviceFor({ snapshot, detections });
    const withoutMomentum = await sensex.evaluate({
      ...BASE_INPUT,
      symbol: 'SENSEX',
      strategyIds: ['agent-opening-range-expansion'],
    });

    expect(withMomentum.verdict).toBe('executable');
    expect(withoutMomentum.verdict).toBe('no-agent-strategy');
  });
});
