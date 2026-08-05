/**
 * Phase 3 runtime verification harness.
 *
 * Boots the REAL AppModule DI graph (so module init, provider resolution and
 * "no duplicate/ambiguous providers" are all exercised for real — Nest throws
 * otherwise), then drives the orchestrator's observe() end-to-end. Only the
 * MARKET_DATA provider is overridden, with a deterministic synthetic-candle
 * stub, because the live Dhan feed's daily token is expired and the backfilled
 * Candle table is a week stale — an environment condition, not a code path.
 * Everything downstream of the snapshot (strategy scan, confidence engine,
 * state machine, strategy advisor, confidence filter) runs the real code.
 *
 *   npm run verify:runtime
 */
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { MARKET_DATA } from '../src/intelligence/market-intelligence.service';
import { SentinelOrchestratorService } from '../src/orchestrator/sentinel-orchestrator.service';
import { StrategyRegistryService } from '../src/learning/strategy-registry.service';
import { StrategyAdvisorService } from '../src/reasoning/strategy-advisor.service';
import { Candle, CandleInterval, MarketBreadth, MarketDataProvider, OptionChainEntry, Quote } from '@tradew/types';

let passes = 0;
let failures = 0;
const results: { label: string; verdict: 'PASS' | 'FAIL'; detail?: string }[] = [];

function record(label: string, ok: boolean, detail?: string): void {
  results.push({ label, verdict: ok ? 'PASS' : 'FAIL', detail });
  if (ok) passes++;
  else failures++;
}

/**
 * Deterministic synthetic candles engineered to produce a confident bullish
 * trend day — a steady uptrend on rising volume — so the confidence engine and
 * state machine can plausibly reach a guidance state and exercise the
 * side-in-focus path. No randomness (banned in this environment anyway).
 */
function syntheticCandles(interval: CandleInterval, from: Date, to: Date): Candle[] {
  const stepMs = interval === '1d' ? 86_400_000 : interval === '15m' ? 900_000 : interval === '5m' ? 300_000 : 60_000;
  const out: Candle[] = [];
  let price = 24000;
  let t = from.getTime();
  let i = 0;
  while (t <= to.getTime()) {
    const open = price;
    const close = price + 12; // steady uptrend
    const high = close + 6;
    const low = open - 4;
    out.push({
      timestamp: new Date(t),
      open,
      high,
      low,
      close,
      volume: 100_000 + i * 5_000, // rising participation
      openInterest: 1_000_000,
    });
    price = close;
    t += stepMs;
    i++;
  }
  return out;
}

const marketDataStub: MarketDataProvider = {
  async getCandles(_symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    return syntheticCandles(interval, from, to);
  },
  async getQuote(symbol: string): Promise<Quote> {
    return { symbol, lastPrice: 24350, change: 350, changePercent: 1.46, volume: 5_000_000, timestamp: new Date('2026-07-30T04:00:00Z') };
  },
  async getOptionChain(): Promise<OptionChainEntry[]> {
    // A put-weighted chain around spot 24350 — corroborates a bullish read.
    return [
      { strike: 24300, expiry: new Date('2026-07-31T00:00:00Z'), callOI: 800_000, putOI: 1_100_000, callVolume: 50_000, putVolume: 70_000, callLtp: 160.5, putLtp: 45.25 },
      { strike: 24350, expiry: new Date('2026-07-31T00:00:00Z'), callOI: 700_000, putOI: 950_000, callVolume: 42_000, putVolume: 61_000, callLtp: 128.75, putLtp: 62.5 },
      { strike: 24400, expiry: new Date('2026-07-31T00:00:00Z'), callOI: 620_000, putOI: 900_000, callVolume: 38_000, putVolume: 55_000, callLtp: 101.0, putLtp: 88.0 },
    ];
  },
  async getMarketBreadth(): Promise<MarketBreadth> {
    return { advances: 38, declines: 12, unchanged: 0, vix: 12.5 };
  },
  async getNews(): Promise<[]> {
    return [];
  },
  async healthCheck(): Promise<boolean> {
    return true;
  },
};

async function main(): Promise<void> {
  console.log('Booting real AppModule (overriding MARKET_DATA only)…\n');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MARKET_DATA)
    .useValue(marketDataStub)
    .compile();

  // If we got here, the entire DI graph resolved: every module initialized and
  // there are no unresolvable or ambiguous providers.
  record('Backend: AppModule boots, all providers resolve (no duplicate/ambiguous)', true);

  // 1. Strategy Registry resolves and loads.
  const registry = moduleRef.get(StrategyRegistryService, { strict: false });
  const exposed = registry.list({ exposedOnly: true });
  record('Backend: StrategyRegistry resolves and exposes exactly 5 strategies', exposed.length === 5, `exposed=${exposed.length}`);

  // 2. Strategy Advisor resolves (same singleton the orchestrator received).
  const advisor = moduleRef.get(StrategyAdvisorService, { strict: false });
  record('Backend: StrategyAdvisor resolves as a provider', !!advisor);

  const orchestrator = moduleRef.get(SentinelOrchestratorService, { strict: false });
  record('Backend: SentinelOrchestrator resolves', !!orchestrator);

  // 3. Observe — AUTO mode, above-threshold synthetic uptrend.
  const auto = await orchestrator.observe({
    userId: 'verify-user',
    symbol: 'NIFTY',
    strategyMode: 'auto',
    confidenceThreshold: 72,
  });
  record('Observe(auto): response includes strategyAdvice', !!auto.strategyAdvice, JSON.stringify(auto.strategyAdvice?.status));
  record('Observe(auto): strategyAdvice.mode === "auto"', auto.strategyAdvice?.mode === 'auto');
  record('Observe(auto): confidence + threshold present', typeof auto.confidence?.score === 'number' && auto.confidence?.threshold === 72, `score=${auto.confidence?.score} threshold=${auto.confidence?.threshold}`);
  record('Observe(auto): sideInFocus field present (value or null)', 'sideInFocus' in auto);
  // Confidence filter contract: sideInFocus is non-null ONLY when the gate is met.
  const sifConsistent = auto.sideInFocus == null ? !auto.confidence.meetsThreshold || !isGuidanceState(auto.marketState.current) : auto.confidence.meetsThreshold;
  record('Confidence filter: sideInFocus is gated by meetsThreshold + guidance state', sifConsistent, `meets=${auto.confidence?.meetsThreshold} state=${auto.marketState?.current} sif=${auto.sideInFocus ? auto.sideInFocus.side : 'null'}`);

  // 4. Observe — MANUAL valid strategy.
  const manualValid = await orchestrator.observe({
    userId: 'verify-user',
    symbol: 'NIFTY',
    strategyMode: 'manual',
    selectedStrategyId: 'trend-pullback',
    confidenceThreshold: 72,
  });
  record('Observe(manual): mode === "manual" with a validation block', manualValid.strategyAdvice?.mode === 'manual' && !!manualValid.strategyAdvice?.validation, JSON.stringify(manualValid.strategyAdvice?.status));

  // 5. Observe — MANUAL invalid id is rejected gracefully (never forced, never a throw).
  const manualBad = await orchestrator.observe({
    userId: 'verify-user',
    symbol: 'NIFTY',
    strategyMode: 'manual',
    selectedStrategyId: 'totally-made-up-id',
    confidenceThreshold: 72,
  });
  record(
    'Security: invalid strategy id handled gracefully (activeStrategyId null, "unknown")',
    manualBad.strategyAdvice?.activeStrategyId === null && (manualBad.strategyAdvice?.status.toLowerCase().includes('unknown') ?? false),
    JSON.stringify(manualBad.strategyAdvice?.status),
  );

  // 6. Security: manual mode cannot bypass confidence filtering — a below-threshold
  //    request must not surface a side, regardless of the selected strategy.
  const lowConf = await orchestrator.observe({
    userId: 'verify-user',
    symbol: 'NIFTY',
    strategyMode: 'manual',
    selectedStrategyId: 'trend-pullback',
    confidenceThreshold: 99, // effectively unreachable — forces the gate closed
  });
  record('Security: manual mode cannot bypass the confidence gate (threshold 99 ⇒ no side)', lowConf.sideInFocus == null, `sif=${lowConf.sideInFocus ? lowConf.sideInFocus.side : 'null'}`);

  // 7. Security: no directive/buy-sell language anywhere in the strategy-focus output.
  const focusText = JSON.stringify([auto.strategyAdvice, auto.sideInFocus, manualValid.strategyAdvice, lowConf.strategyAdvice]).toLowerCase();
  const forbidden = ['buy now', 'sell now', 'go long here', 'go short here', 'entry:', 'target:', 'you should buy', 'you should sell'];
  const leaked = forbidden.filter((p) => focusText.includes(p));
  record('Security: no buy/sell directive language in strategy-focus output', leaked.length === 0, leaked.join(','));

  // 8. Serialization: the whole response round-trips through JSON unchanged (survives the API proxy + fetch).
  let serializes = true;
  try {
    const round = JSON.parse(JSON.stringify(auto));
    serializes = !!round.strategyAdvice && 'sideInFocus' in round && round.confidence.threshold === 72;
  } catch {
    serializes = false;
  }
  record('Integration: full observe response is JSON-serializable (survives proxy + fetch)', serializes);

  // 9. Registry endpoint exposes ONLY allowed strategies (exposed flag honoured).
  const registryExposedOnly = registry.list({ exposedOnly: true }).every((s) => s.exposed);
  record('Security: registry exposed-only list contains only exposed strategies', registryExposedOnly);

  // 10. Observe — MANUAL, multiple strategies pinned simultaneously (Phase 2).
  const multi = await orchestrator.observe({
    userId: 'verify-user',
    symbol: 'NIFTY',
    strategyMode: 'manual',
    selectedStrategyIds: ['trend-pullback', 'vwap-reversal'],
    confidenceThreshold: 72,
  });
  record(
    'Observe(multi-strategy): strategyAdvices has one entry per pinned id',
    Array.isArray(multi.strategyAdvices) && multi.strategyAdvices.length === 2,
    `count=${multi.strategyAdvices?.length}`,
  );
  record(
    'Observe(multi-strategy): each entry addresses the strategy it was pinned for',
    multi.strategyAdvices?.[0]?.requestedStrategyId === 'trend-pullback' &&
      multi.strategyAdvices?.[1]?.requestedStrategyId === 'vwap-reversal',
    JSON.stringify(multi.strategyAdvices?.map((a) => a.requestedStrategyId)),
  );
  record(
    'Observe(multi-strategy): strategyAdvice mirrors the first pinned entry (backward compat)',
    multi.strategyAdvice?.requestedStrategyId === multi.strategyAdvices?.[0]?.requestedStrategyId,
  );
  record(
    'Observe(multi-strategy): legacy selectedStrategyId still works as a single-item fallback',
    manualValid.strategyAdvices?.length === 1 && manualValid.strategyAdvices?.[0]?.requestedStrategyId === 'trend-pullback',
    JSON.stringify(manualValid.strategyAdvices),
  );

  await moduleRef.close();

  // -------- report --------
  console.log('\n================ RUNTIME VERIFICATION ================\n');
  for (const r of results) {
    const line = `${r.verdict.padEnd(4)}  ${r.label}`;
    if (r.verdict === 'PASS') console.log(line);
    else console.error(`${line}\n        → ${r.detail ?? ''}`);
  }
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exit(1);
}

function isGuidanceState(state: string): boolean {
  return ['SIDE_IN_FOCUS', 'OPPORTUNITY_ACTIVE', 'MOVE_DEVELOPING', 'MOMENTUM_WEAKENING', 'MOVE_COMPLETE'].includes(state);
}

main().catch((err) => {
  console.error('\nRUNTIME VERIFICATION CRASHED:');
  console.error(err?.stack ?? err);
  process.exit(2);
});
