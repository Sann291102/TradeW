/**
 * EMA-cross scalp backtest — runnable proof, no database required.
 *
 *   npm run backtest:ema
 *   npm run backtest:ema -- --symbol NIFTY --interval 5m --days 30 --ema 7 --rr 2
 *   npm run backtest:ema -- --symbol RELIANCE --interval 15m --days 60 --rr 3 --fresh --cooldown 6
 *
 * OBSERVATION / EDUCATION ONLY (ARCHITECTURE.md §3–4). This measures how the
 * user's "EMA(7) cross a green candle -> scalp 1:2/1:3" rule WOULD have behaved
 * on historical bars. It is not a live signal and touches no order flow.
 *
 * Data source: the deterministic `SimulatedMarketDataProvider` by default, so
 * this runs with markets closed and no DB. It reads bars through the exact same
 * `MarketDataProvider.getCandles()` contract that already serves real Dhan
 * history in production (CandleMarketDataProvider: live bridge -> Candle table ->
 * simulator), so pointing it at real bars is a one-line provider swap, not a
 * rewrite.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') }); // root .env — see .env.example
import { PrismaClient } from '@prisma/client';
import { SimulatedMarketDataProvider } from '@tradew/market-data';
import type { Candle, CandleInterval } from '@tradew/types';
import { ema } from '../src/intelligence/indicators';
import { runEmaCrossBacktest } from '../src/backtest/engine';
import { DEFAULT_EMA_CROSS_CONFIG, type BacktestResult, type EmaCrossConfig } from '../src/backtest/types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const symbol = arg('symbol', 'NIFTY')!;
const source = arg('source', 'db') as 'db' | 'sim'; // 'db' = real Dhan Candle table, 'sim' = deterministic simulator
const interval = arg('interval', source === 'db' ? '15m' : '5m')!; // native: 1m/5m/15m/1d; '3m' is resampled from 1m
const days = Number(arg('days', source === 'db' ? '120' : '30'));

const cfg: EmaCrossConfig = {
  ...DEFAULT_EMA_CROSS_CONFIG,
  emaPeriod: Number(arg('ema', String(DEFAULT_EMA_CROSS_CONFIG.emaPeriod))),
  rewardRisk: Number(arg('rr', String(DEFAULT_EMA_CROSS_CONFIG.rewardRisk))),
  timeoutBars: Number(arg('timeout', String(DEFAULT_EMA_CROSS_CONFIG.timeoutBars))),
  cooldownBars: Number(arg('cooldown', String(DEFAULT_EMA_CROSS_CONFIG.cooldownBars))),
  requireFreshCross: flag('fresh'),
  costPct: Number(arg('cost', '0')) / 100, // --cost 0.05 means 0.05% round-trip
  trendEmaPeriod: Number(arg('trend', '0')), // --trend 50 = require close > EMA(50)
  minBodyPct: Number(arg('minbody', '0')) / 100, // --minbody 0.05 = body >= 0.05% of price
  requireVolumeConfirm: flag('vol'),
};

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '∞');
const pad = (s: string | number, w: number) => String(s).padStart(w);

function printReport(r: BacktestResult): void {
  const s = r.stats;
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(`  EMA-CROSS SCALP BACKTEST   ${s.symbol}  ·  ${s.interval}  ·  ${days}d`);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  data source : ${r.dataSource}`);
  console.log(`  window      : ${s.from.toISOString().slice(0, 16)}  →  ${s.to.toISOString().slice(0, 16)}   (${s.barCount} bars)`);
  console.log(
    `  rule        : EMA(${r.config.emaPeriod}) crosses a bullish candle → long, ` +
      `1:${r.config.rewardRisk} R:R, stop=signal low, timeout=${r.config.timeoutBars} bars, cooldown=${r.config.cooldownBars}`,
  );
  console.log(
    `  filters     : freshCross=${r.config.requireFreshCross}, trendEMA=${r.config.trendEmaPeriod || 'off'}, ` +
      `minBody=${r.config.minBodyPct ? (r.config.minBodyPct * 100).toFixed(2) + '%' : 'off'}, ` +
      `volConfirm=${r.config.requireVolumeConfirm}, cost=${(r.config.costPct * 100).toFixed(3)}% round-trip`,
  );
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  trades              ${pad(s.trades, 8)}`);
  console.log(`  wins / losses / TO  ${pad(`${s.wins} / ${s.losses} / ${s.timeouts}`, 8)}`);
  console.log(`  win rate            ${pad(f2(s.winRatePct) + '%', 8)}`);
  console.log(`  avg win / avg loss  ${pad(f2(s.avgWinR) + 'R', 8)} / ${f2(s.avgLossR)}R`);
  console.log(`  expectancy / trade  ${pad(f2(s.expectancyR) + 'R', 8)}   ← the number that matters`);
  console.log(`  total               ${pad(f2(s.totalR) + 'R', 8)}   (${f2(s.totalPoints)} pts)`);
  console.log(`  profit factor       ${pad(f2(s.profitFactor), 8)}`);
  console.log(`  max losing streak   ${pad(s.maxConsecutiveLosses, 8)}`);
  console.log(`  max drawdown        ${pad(f2(s.maxDrawdownR) + 'R', 8)}`);

  const sample = r.trades.slice(0, 12);
  if (sample.length) {
    console.log('  ─────────────────────────────────────────────────────────────');
    console.log('  first trades:');
    console.log('     entry@            price     stop    target   exit    outcome    R');
    for (const t of sample) {
      console.log(
        `     ${t.entryTime.toISOString().slice(5, 16)}  ${pad(t.entryPrice.toFixed(1), 8)} ${pad(t.stop.toFixed(1), 8)} ${pad(
          t.target.toFixed(1),
          8,
        )} ${pad(t.exitPrice.toFixed(1), 8)}  ${pad(t.outcome, 8)} ${pad(f2(t.rMultiple), 6)}`,
      );
    }
  }
}

/** Real Dhan bars from the persisted Candle table — the same rows the production
 *  CandleMarketDataProvider serves, read directly here so the script needs no DI. */
async function candlesFromDb(sym: string, tf: CandleInterval, from: Date, to: Date): Promise<{ candles: Candle[]; source: string }> {
  const prisma = new PrismaClient();
  try {
    const inst = await prisma.instrument.findUnique({ where: { symbol: sym }, select: { id: true } });
    if (!inst) return { candles: [], source: `db(no instrument '${sym}')` };
    const rows = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: tf, bucketStart: { gte: from, lte: to } },
      orderBy: { bucketStart: 'asc' },
    });
    const candles: Candle[] = rows.map((r) => ({
      timestamp: r.bucketStart,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      openInterest: r.openInterest != null ? Number(r.openInterest) : undefined,
    }));
    return { candles, source: `dhan (Candle table, source='dhan')` };
  } finally {
    await prisma.$disconnect();
  }
}

/** Aggregate finer bars up to a coarser timeframe (e.g. 1m → 3m). Buckets by
 *  wall-clock boundary so it never merges bars across a session gap. */
function resample(fine: Candle[], factorMinutes: number): Candle[] {
  const bucketMs = factorMinutes * 60_000;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBucket = -1;
  for (const c of fine) {
    const b = Math.floor(c.timestamp.getTime() / bucketMs);
    if (b !== curBucket) {
      if (cur) out.push(cur);
      cur = { ...c, timestamp: new Date(b * bucketMs) };
      curBucket = b;
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  let candles: Candle[];
  let dataSource: string;
  if (source === 'db') {
    // Native timeframes read straight from the table; '3m' (and any non-native
    // Xm) is resampled from real 1m bars.
    const native = ['1m', '5m', '15m', '1h', '1d'];
    if (!native.includes(interval) && /^\d+m$/.test(interval)) {
      const factor = Number(interval.replace('m', ''));
      const base = await candlesFromDb(symbol, '1m', from, to);
      candles = resample(base.candles, factor);
      dataSource = `${base.source} → ${interval} resampled`;
    } else {
      const res = await candlesFromDb(symbol, interval as CandleInterval, from, to);
      candles = res.candles;
      dataSource = res.source;
    }
    if (!candles.length) {
      console.error(
        `No real ${interval} bars for '${symbol}' in the Candle table.\n` +
          `Available (from the backfill): NIFTY/BANKNIFTY/FINNIFTY/RELIANCE/COALINDIA at 15m and 1d.\n` +
          `Backfill more with:  cd services/market-data && npm run backfill:candles\n` +
          `Or run on the simulator with:  --source sim`,
      );
      process.exit(1);
    }
  } else {
    const provider = new SimulatedMarketDataProvider();
    // Same cast the DB path above already applies: `interval` is a raw CLI
    // string. Kept as a cast rather than promoted to validation because this
    // is a developer backtest harness and throwing on a typo would be a
    // behaviour change during the pre-live-validation freeze.
    candles = await provider.getCandles(symbol, interval as CandleInterval, from, to);
    dataSource = provider.name;
  }

  if (candles.length < cfg.emaPeriod + 5) {
    console.error(`Not enough bars (${candles.length}) for EMA(${cfg.emaPeriod}). Try a longer --days or finer --interval.`);
    process.exit(1);
  }

  if (flag('debug')) {
    const closes = candles.map((c) => c.close);
    const e = ema(closes, cfg.emaPeriod);
    let bullish = 0;
    let through = 0;
    let above = 0;
    let all = 0;
    let bodySum = 0;
    let rangeSum = 0;
    let emaDistSum = 0;
    for (let i = cfg.emaPeriod; i < candles.length; i++) {
      const c = candles[i];
      const isBull = c.close > c.open;
      const isThrough = c.low <= e[i] && e[i] <= c.high;
      const isAbove = c.close > e[i];
      if (isBull) bullish++;
      if (isThrough) through++;
      if (isAbove) above++;
      if (isBull && isThrough && isAbove) all++;
      bodySum += Math.abs(c.close - c.open);
      rangeSum += c.high - c.low;
      emaDistSum += Math.abs(c.close - e[i]);
    }
    const nn = candles.length - cfg.emaPeriod;
    console.log('\n  ─── DEBUG: clause hit-counts over', nn, 'bars ───');
    console.log(`  bullish (close>open)      : ${bullish}`);
    console.log(`  emaThroughBar (low≤e≤high): ${through}`);
    console.log(`  closesAbove (close>e)     : ${above}`);
    console.log(`  ALL THREE (a trigger)     : ${all}`);
    console.log(`  avg body    : ${(bodySum / nn).toFixed(2)} pts`);
    console.log(`  avg range   : ${(rangeSum / nn).toFixed(2)} pts`);
    console.log(`  avg |close-ema| : ${(emaDistSum / nn).toFixed(2)} pts  (if >> range, the EMA rarely sits inside a bar)`);
    for (let i = cfg.emaPeriod; i < cfg.emaPeriod + 6; i++) {
      const c = candles[i];
      console.log(`   bar${i}: o=${c.open} h=${c.high} l=${c.low} c=${c.close}  ema=${e[i].toFixed(2)}`);
    }
  }

  const result = runEmaCrossBacktest(symbol, interval, candles, cfg, dataSource);
  printReport(result);

  // Layer each fake-spike lever on the SAME bars, cumulatively, so its marginal
  // effect is visible. Cost (0.05% round-trip) is applied throughout except the
  // first "gross" row, so the gap between gross and net is explicit.
  const layers: Array<[string, Partial<EmaCrossConfig>]> = [
    ['bare rule (gross)', { costPct: 0 }],
    ['+ cost 0.05%', { costPct: 0.0005 }],
    ['+ freshCross', { costPct: 0.0005, requireFreshCross: true }],
    ['+ trend EMA(50)', { costPct: 0.0005, requireFreshCross: true, trendEmaPeriod: 50 }],
    ['+ volume confirm', { costPct: 0.0005, requireFreshCross: true, trendEmaPeriod: 50, requireVolumeConfirm: true }],
  ];
  console.log('\n  ─── fake-spike filters, layered cumulatively (same bars) ──────');
  console.log('   layer                trades   win%    expect/tr   totalR    maxDD');
  for (const [label, patch] of layers) {
    const s = runEmaCrossBacktest(symbol, interval, candles, { ...cfg, ...patch }, dataSource).stats;
    console.log(
      `   ${label.padEnd(20)} ${pad(s.trades, 6)}   ${pad(f2(s.winRatePct), 5)}   ${pad(f2(s.expectancyR) + 'R', 9)}   ${pad(
        f2(s.totalR) + 'R',
        7,
      )}   ${pad(f2(s.maxDrawdownR) + 'R', 6)}`,
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
