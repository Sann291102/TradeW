/**
 * Phase 3 test suite — Strategy Registry + Strategy Advisor + Side in Focus.
 *
 * Deterministic, DB-free. Builds minimal but realistic MarketSnapshot,
 * ConfidenceBreakdown and StrategyDetection fixtures and asserts the
 * auto/manual/validation/side-in-focus behaviour, including the confidence
 * filter that keeps weak reads off-screen.
 *
 *   npm run advisor:test
 */
import { StrategyRegistryService } from '../src/learning/strategy-registry.service';
import { StrategyAdvisorService } from '../src/reasoning/strategy-advisor.service';
import { ConfidenceBreakdown, MarketStateValue } from '../src/domain';
import type { PublicationDecision } from '../src/orchestrator/publication-gate';
import { MarketSnapshot } from '../src/intelligence/market-intelligence.service';
import { StrategyDetection, StrategyEngineService } from '../src/intelligence/strategy-engine.service';

// The real detector ids, read straight from the engine's built-in set (no DI,
// no user YAML — onModuleInit is not called here), so the registry's
// detectionStrategyId links are checked against ground truth, not a copy.
const BUILT_IN_STRATEGY_IDS = new Set(new StrategyEngineService().getStrategies().map((s) => s.id));

let passes = 0;
let failures = 0;

function test(name: string, body: () => void): void {
  try {
    body();
    passes++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
  }
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

function assert(cond: unknown, message = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(message);
}
function assertEq<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---- fixtures -----------------------------------------------------------

function makeConfidence(score: number, threshold = 72): ConfidenceBreakdown {
  return {
    score,
    weightedScore: score,
    threshold,
    meetsThreshold: score >= threshold,
    factors: [],
    deductions: [],
    computedAt: new Date('2026-07-30T04:00:00Z').toISOString(),
  };
}

/**
 * A publication decision for the advisor harness.
 *
 * `sideInFocus` no longer evaluates confidence or session state itself — the
 * four-condition publication gate is the single authority, and this stands in
 * for its verdict. See `StrategyAdvisorService.sideInFocus`.
 */
function makePublication(publish: boolean, threshold = 72): PublicationDecision {
  return {
    publish,
    threshold,
    confidence: publish ? 84 : 65,
    conditions: [],
    corroboratingSources: publish ? ['session structure', 'historical outcomes'] : [],
    conflicts: [],
    waitAndWatchReason: publish ? null : 'Gate did not clear. Sentinel remains in Wait and Watch.',
  };
}

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    lastPrice: 24350,
    volumeVsAvg: 1.2,
    marketProfile: { type: 'Bullish Trend Day', description: 'x', trend: 'bullish', volatility: 'normal', structure: 'trending', evidence: [] },
    trendAnalysis: { direction: 'bullish', momentumScore: 0.7, sessionChangePct: 0.85 },
    optionChain: { pcr: 1.15, maxPain: 24300, callOIWall: 24500, putOIWall: 24000, strikesAnalysed: 20 },
    vix: 13.5,
    ...overrides,
  } as unknown as MarketSnapshot;
}

function makeDetection(overrides: Partial<StrategyDetection> = {}): StrategyDetection {
  return {
    strategyId: 'liquidity-sweep',
    strategyName: 'Liquidity Sweep',
    confidence: 82,
    bias: 'bullish',
    rulesMatched: ['liquidity sweep confirmed on the prior low', 'sweep volume spike present'],
    rulesUnmet: [],
    invalidationsTriggered: [],
    detectedAt: new Date('2026-07-30T04:00:00Z').toISOString(),
    validated: true,
    source: 'built-in',
    ...overrides,
  };
}

const GUIDANCE_STATE: MarketStateValue = 'SIDE_IN_FOCUS';
const NON_GUIDANCE_STATE: MarketStateValue = 'MARKET_UNDERSTANDING';

function newAdvisor(): { advisor: StrategyAdvisorService; registry: StrategyRegistryService } {
  const registry = new StrategyRegistryService();
  const advisor = new StrategyAdvisorService(registry);
  return { advisor, registry };
}

// ---- Registry -----------------------------------------------------------

section('StrategyRegistry');
{
  const { registry } = newAdvisor();

  test('exposes exactly 5 strategies by default', () => {
    assertEq(registry.list({ exposedOnly: true }).length, 5);
  });

  test('full registry has 10–15 strategies', () => {
    const all = registry.list();
    assert(all.length >= 10 && all.length <= 15, `expected 10–15, got ${all.length}`);
  });

  test('exposed strategies are the first by order', () => {
    const exposed = registry.list({ exposedOnly: true });
    const orders = exposed.map((s) => s.order);
    assertEq(orders.join(','), '1,2,3,4,5');
  });

  test('every detectionStrategyId maps to a real built-in detector or is null', () => {
    for (const s of registry.list()) {
      if (s.detectionStrategyId !== null) {
        assert(BUILT_IN_STRATEGY_IDS.has(s.detectionStrategyId), `${s.id} → unknown detector ${s.detectionStrategyId}`);
      }
    }
  });

  test('byDetectionId reverse lookup works', () => {
    const entry = registry.byDetectionId('liquidity-sweep');
    assert(entry !== null, 'expected a registry entry for liquidity-sweep');
    assertEq(entry!.id, 'ict-liquidity-sweep');
  });

  test('every strategy carries the full educational payload', () => {
    for (const s of registry.list()) {
      assert(s.purpose.length > 0, `${s.id} missing purpose`);
      assert(s.marketConditions.length > 0, `${s.id} missing marketConditions`);
      assert(s.timeframes.length > 0, `${s.id} missing timeframes`);
      assert(s.requiredIndicators.length > 0, `${s.id} missing requiredIndicators`);
      assert(s.riskConsiderations.length > 0, `${s.id} missing riskConsiderations`);
      assert(s.whenNotToUse.length > 0, `${s.id} missing whenNotToUse`);
      assert(s.educational.length > 0, `${s.id} missing educational`);
      assert(s.regimes.length > 0, `${s.id} missing regimes`);
    }
  });
}

// ---- Auto mode ----------------------------------------------------------

section('Advisor — Auto mode');
{
  const { advisor } = newAdvisor();

  test('auto picks the leading validated detection above threshold', () => {
    const advice = advisor.advise({
      mode: 'auto',
      requestedStrategyId: null,
      detections: [makeDetection()],
      confidence: makeConfidence(84),
      snapshot: makeSnapshot(),
      regime: 'ranging',
      state: GUIDANCE_STATE,
    });
    assertEq(advice.mode, 'auto');
    assert(advice.aiSelected, 'expected aiSelected true');
    assert(advice.status.startsWith('AI Selected:'), `unexpected status: ${advice.status}`);
    assert(advice.activeStrategyName?.includes('Liquidity Sweep'), `unexpected name: ${advice.activeStrategyName}`);
  });

  test('auto below threshold reports "Waiting for stronger confirmation"', () => {
    const advice = advisor.advise({
      mode: 'auto',
      requestedStrategyId: null,
      detections: [makeDetection({ validated: false, rulesUnmet: ['x'], confidence: 40 })],
      confidence: makeConfidence(58),
      snapshot: makeSnapshot(),
      regime: 'ranging',
      state: 'STRATEGY_DETECTION',
    });
    assert(!advice.aiSelected, 'expected aiSelected false below threshold');
    assertEq(advice.status, 'Waiting for stronger confirmation');
  });

  test('auto with no detections reports scanning', () => {
    const advice = advisor.advise({
      mode: 'auto',
      requestedStrategyId: null,
      detections: [],
      confidence: makeConfidence(30),
      snapshot: makeSnapshot(),
      regime: null,
      state: 'OBSERVATION',
    });
    assertEq(advice.activeStrategyId, null);
    assert(advice.status.toLowerCase().includes('scanning'), `unexpected: ${advice.status}`);
  });
}

// ---- Manual mode --------------------------------------------------------

section('Advisor — Manual mode');
{
  const { advisor } = newAdvisor();

  test('manual pick passes when regime, confirmations and confidence align', () => {
    // ict-liquidity-sweep suits ranging/accumulation/distribution regimes.
    const advice = advisor.advise({
      mode: 'manual',
      requestedStrategyId: 'ict-liquidity-sweep',
      detections: [makeDetection()],
      confidence: makeConfidence(84),
      snapshot: makeSnapshot({ marketProfile: { type: 'High Volatility Range', description: 'x', trend: 'neutral', volatility: 'normal', structure: 'ranging', evidence: [] } }),
      regime: 'ranging',
      state: GUIDANCE_STATE,
    });
    assertEq(advice.mode, 'manual');
    assert(advice.validation, 'expected a validation block');
    assert(advice.validation!.passed, `expected pass, got: ${advice.message}`);
    assertEq(advice.marketSuitability, 'high');
  });

  test('manual pick fails on incompatible regime', () => {
    // trend-pullback only suits trending; give it a ranging regime.
    const advice = advisor.advise({
      mode: 'manual',
      requestedStrategyId: 'trend-pullback',
      detections: [],
      confidence: makeConfidence(84),
      snapshot: makeSnapshot(),
      regime: 'ranging',
      state: GUIDANCE_STATE,
    });
    assert(advice.validation && !advice.validation.passed, 'expected validation to fail');
    assert(!advice.validation!.regimeCompatible, 'expected regimeCompatible false');
    assertEq(advice.status, 'Selected strategy does not currently have sufficient confirmation.');
  });

  test('manual pick fails below the confidence threshold', () => {
    const advice = advisor.advise({
      mode: 'manual',
      requestedStrategyId: 'ict-liquidity-sweep',
      detections: [makeDetection()],
      confidence: makeConfidence(60),
      snapshot: makeSnapshot(),
      regime: 'ranging',
      state: 'STRATEGY_DETECTION',
    });
    assert(advice.validation && !advice.validation.passed, 'expected fail below threshold');
    assert(advice.message.includes('below the'), `expected threshold reason, got: ${advice.message}`);
  });

  test('manual pick fails when required confirmations are missing', () => {
    const advice = advisor.advise({
      mode: 'manual',
      requestedStrategyId: 'ict-liquidity-sweep',
      detections: [makeDetection({ validated: false, rulesMatched: [], rulesUnmet: ['liquidity sweep not seen'] })],
      confidence: makeConfidence(84),
      snapshot: makeSnapshot(),
      regime: 'ranging',
      state: 'STRATEGY_DETECTION',
    });
    assert(advice.validation && !advice.validation.passed, 'expected fail on missing confirmations');
    assert(advice.validation!.missingConfirmations.length > 0, 'expected missing confirmations listed');
  });

  test('unknown strategy id is reported, never forced', () => {
    const advice = advisor.advise({
      mode: 'manual',
      requestedStrategyId: 'does-not-exist',
      detections: [makeDetection()],
      confidence: makeConfidence(90),
      snapshot: makeSnapshot(),
      regime: 'trending',
      state: GUIDANCE_STATE,
    });
    assertEq(advice.activeStrategyId, null);
    assertEq(advice.marketSuitability, 'unknown');
    assert(advice.status.toLowerCase().includes('unknown'), `unexpected: ${advice.status}`);
  });
}

// ---- Side in Focus ------------------------------------------------------

section('Advisor — Side in Focus');
{
  const { advisor } = newAdvisor();

  test('bullish setup above threshold surfaces CE with an ATM strike', () => {
    const sif = advisor.sideInFocus({
      symbol: 'NIFTY',
      detections: [makeDetection({ bias: 'bullish' })],
      confidence: makeConfidence(84),
      snapshot: makeSnapshot({ lastPrice: 24337 }),
      state: GUIDANCE_STATE,
      publication: makePublication(true),
    });
    assert(sif !== null, 'expected a side in focus');
    assertEq(sif!.side, 'CE');
    assertEq(sif!.bias, 'bullish');
    // 24337 rounded to nearest 50 = 24350
    assertEq(sif!.strike, 24350);
    assertEq(sif!.tradeManagement.riskReward, '1:3');
    assertEq(sif!.tradeManagement.trailing.join(','), '1:1,1:2,1:3');
    assert(sif!.disclaimer.toLowerCase().includes('not a buy/sell'), 'expected non-directive disclaimer');
  });

  test('bearish setup surfaces PE', () => {
    const sif = advisor.sideInFocus({
      symbol: 'BANKNIFTY',
      detections: [makeDetection({ bias: 'bearish', strategyName: 'Fake Breakout' })],
      confidence: makeConfidence(80),
      snapshot: makeSnapshot({ lastPrice: 51240, trendAnalysis: { direction: 'bearish', momentumScore: 0.6, sessionChangePct: -0.7, volumeStrength: 1.1 } }),
      state: 'OPPORTUNITY_ACTIVE',
      publication: makePublication(true),
    });
    assert(sif !== null, 'expected a side in focus');
    assertEq(sif!.side, 'PE');
    // 51240 rounded to nearest 100 = 51200
    assertEq(sif!.strike, 51200);
  });

  // Renamed: this no longer tests a confidence check inside sideInFocus —
  // confidence is one of four conditions the publication gate evaluates, and
  // sideInFocus now honours that single verdict.
  test('PUBLICATION GATE: a gate that did not clear returns null (nothing weak shown)', () => {
    const sif = advisor.sideInFocus({
      symbol: 'NIFTY',
      detections: [makeDetection({ bias: 'bullish' })],
      confidence: makeConfidence(65),
      snapshot: makeSnapshot(),
      state: GUIDANCE_STATE,
      publication: makePublication(false),
    });
    assertEq(sif, null);
  });

  test('PUBLICATION GATE: a non-guidance state is caught by the gate, not by sideInFocus', () => {
    const sif = advisor.sideInFocus({
      symbol: 'NIFTY',
      detections: [makeDetection({ bias: 'bullish' })],
      confidence: makeConfidence(90),
      snapshot: makeSnapshot(),
      state: NON_GUIDANCE_STATE,
      publication: makePublication(false),
    });
    assertEq(sif, null);
  });

  test('neutral bias returns null (no side to focus)', () => {
    const sif = advisor.sideInFocus({
      symbol: 'NIFTY',
      detections: [makeDetection({ bias: 'neutral' })],
      confidence: makeConfidence(90),
      snapshot: makeSnapshot({ trendAnalysis: { direction: 'neutral', momentumScore: 0.5, sessionChangePct: 0, volumeStrength: 1 } }),
      state: GUIDANCE_STATE,
      publication: makePublication(true),
    });
    assertEq(sif, null);
  });

  test('rationale cites the leading detection and option chain', () => {
    const sif = advisor.sideInFocus({
      symbol: 'NIFTY',
      detections: [makeDetection({ bias: 'bullish' })],
      confidence: makeConfidence(84),
      snapshot: makeSnapshot(),
      state: GUIDANCE_STATE,
      publication: makePublication(true),
    });
    assert(sif !== null);
    assert(sif!.rationale.some((r) => r.includes('Liquidity Sweep')), 'expected detection in rationale');
    assert(sif!.rationale.some((r) => r.includes('Put-Call OI ratio')), 'expected option chain in rationale');
  });
}

console.log(`\n---`);
console.log(`Results: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
