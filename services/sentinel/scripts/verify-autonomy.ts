/**
 * Autonomy verification harness.
 *
 * Answers one question with evidence rather than inference: does Sentinel
 * observe the market when nobody is looking at it?
 *
 * Three things have to be true, and this checks each against the REAL DI graph
 * and the REAL live candle feed — no synthetic data anywhere (unlike
 * `verify:runtime`, which stubs `MARKET_DATA` deliberately):
 *
 *   1. observing a symbol registers it with the continuous watch, idempotently
 *   2. a sweep with a registered symbol actually executes — the `no-symbols`
 *      guard that swallowed every tick for a whole trading day is gone
 *   3. a detection is stamped with the bar it matched on, not the clock the
 *      scan ran on
 *
 * ## The one thing that is injected, and why
 *
 * `sweep(at)` and `scan(snapshot, at)` take their clock as an argument — that is
 * why they are public, and it is the only way a timer-driven loop is testable at
 * all. This harness passes an instant inside the current trading session so the
 * session guard does not decline, which is what lets it be run after the close
 * to verify the code path. The MARKET DATA is entirely real: today's candles,
 * pulled through the same provider the service uses. Nothing here fabricates a
 * price, a bar or a timestamp.
 *
 * ## Why it records nothing
 *
 * The probe watch is constructed with a null `PatternRecognitionService`, so it
 * observes and scans exactly as production does but writes no occurrences to the
 * Brain. Base-rate integrity is the whole point of the re-record cooldown
 * (`MarketWatchService.claimCooldown`); a verification run must not be able to
 * add evidence to the sample the live-performance gate reads.
 *
 *   npm run autonomy:verify -w @tradew/sentinel
 *   npm run autonomy:verify -w @tradew/sentinel -- BANKNIFTY
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
// Before AppModule, exactly as `src/main.ts` does it: the module's provider
// factories read env at construction, and without this the candle provider has
// no bridge URL and Prisma no database — so a real feed reads as "no market
// data available", which is a config fault wearing a data fault's error message.
// `override` matches main.ts: this host pre-sets some of these to empty strings.
loadEnv({ path: resolve(__dirname, '../../../.env'), override: true }); // root .env — see .env.example
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { MarketIntelligenceService, latestBarAt } from '../src/intelligence/market-intelligence.service';
import { StrategyEngineService } from '../src/intelligence/strategy-engine.service';
import { SentinelIntelligenceService } from '../src/sentinel-intelligence/sentinel-intelligence.service';
import { MarketWatchService } from '../src/sentinel-intelligence/watch/market-watch.service';
import { SI_CONFIG, type SentinelIntelligenceConfig } from '../src/sentinel-intelligence/si.config';
import { MARKET_CLOSE_MIN, MARKET_OPEN_MIN, istMinutesOfDay, istTimeLabel } from '../src/market-clock';

let passes = 0;
let failures = 0;
const results: { label: string; verdict: 'PASS' | 'FAIL'; detail: string }[] = [];

function record(label: string, ok: boolean, detail: string): void {
  results.push({ label, verdict: ok ? 'PASS' : 'FAIL', detail });
  if (ok) passes++;
  else failures++;
}

/**
 * An instant inside the current IST trading session.
 *
 * Returns `now` untouched when the market is open, so a run during the session
 * injects nothing at all. Outside it, walks back to one minute before the close
 * of the same IST day — the last moment the session guard would have allowed.
 */
function inSession(now: Date): { at: Date; injected: boolean } {
  const minutes = istMinutesOfDay(now);
  if (minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN) return { at: now, injected: false };
  const shiftMinutes = MARKET_CLOSE_MIN - 1 - minutes;
  return { at: new Date(now.getTime() + shiftMinutes * 60_000), injected: true };
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] || 'NIFTY').toUpperCase();
  const now = new Date();
  const { at, injected } = inSession(now);

  console.log('Sentinel autonomy verification');
  console.log(`  symbol         ${symbol}`);
  console.log(`  wall clock     ${now.toISOString()}  (${istTimeLabel(now)} IST)`);
  console.log(
    `  sweep clock    ${at.toISOString()}  (${istTimeLabel(at)} IST)` +
      (injected ? '  [INJECTED — market is closed; data is still live]' : '  [live session, not injected]'),
  );
  console.log('');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = await moduleRef.init();

  const config = app.get<SentinelIntelligenceConfig>(SI_CONFIG);
  const market = app.get(MarketIntelligenceService);
  const strategies = app.get(StrategyEngineService);
  const intelligence = app.get(SentinelIntelligenceService);

  // ---- 1. observing registers, idempotently -------------------------------
  // Driven through the exact method `/observe` calls, so this exercises the
  // production wiring rather than a copy of it.
  intelligence.watchSymbol(symbol, at);
  intelligence.watchSymbol(symbol, at);
  intelligence.watchSymbol(symbol.toLowerCase(), at);

  const liveWatch = app.get(MarketWatchService).status(at);
  record(
    'observing a symbol registers it with the watch',
    liveWatch.watching.includes(symbol),
    `watching=${JSON.stringify(liveWatch.watching)}`,
  );
  record(
    'three observations of one symbol create one watcher',
    liveWatch.watching.filter((s) => s === symbol).length === 1,
    `watching=${JSON.stringify(liveWatch.watching)}`,
  );
  // The expiry is `max(at + ttl, today's close)`, so which of the two wins
  // depends on when this runs — a minute before the bell, the TTL floor does.
  // The check is that the session-aware policy is in force and produced an
  // expiry, not that either particular bound won.
  record(
    'watch expiry comes from the session-aware policy, not the poll',
    liveWatch.persistsThroughSession && typeof liveWatch.watchedUntil[symbol] === 'string',
    `watchedUntil=${liveWatch.watchedUntil[symbol] ?? '-'} (max of at+ttl and today's close)`,
  );

  // ---- 2. a sweep with a registered symbol executes ------------------------
  // Read-only probe: real market data, real rules, no Brain writes.
  const probe = new MarketWatchService(config, market, strategies, null);
  probe.register(symbol, at);
  const sweep = await probe.sweep(at);
  const probeStatus = probe.status(at);

  record(
    'a sweep with a registered symbol is no longer declined',
    sweep.skipped === null,
    `skipped=${sweep.skipped ?? 'null'} symbols=${sweep.symbols} detections=${sweep.detections}`,
  );
  record(
    'the sweep is counted and timestamped',
    probeStatus.sweeps > 0 && probeStatus.lastSweepAt !== null,
    `sweeps=${probeStatus.sweeps} lastSweepAt=${probeStatus.lastSweepAt ?? 'null'}`,
  );
  record(
    'the probe wrote nothing to the Brain',
    probeStatus.recording === false && sweep.recorded === 0,
    `recording=${probeStatus.recording} recorded=${sweep.recorded}`,
  );

  // ---- 3. detections carry market time, not the scan clock ----------------
  // Caught rather than thrown: a feed outage is an environment condition, and
  // the checks above have already produced results worth printing.
  const snapshot = await market.snapshot(symbol).catch((err: Error) => {
    record('live market data available for the timestamp check', false, err.message);
    return null;
  });
  if (!snapshot) {
    await app.close();
    report();
    return;
  }

  const barAt = latestBarAt(snapshot);
  const detections = strategies.scan(snapshot, at);

  record(
    'the live snapshot has a bar to date detections from',
    barAt !== null,
    `latestBarAt=${barAt?.toISOString() ?? 'null'} sessionBars=${snapshot.sessionCandles.length}`,
  );
  if (detections.length === 0) {
    // Not a failure: no confirmed rule anywhere in the handbook is a legitimate
    // market state, and inventing one to make a check pass would defeat it.
    record(
      'detections available to date-check',
      false,
      'no strategy matched the live snapshot — re-run during a session with active structure',
    );
  } else {
    const allOnBar = detections.every((d) => d.detectedAt === barAt?.toISOString());
    const noneOnScanClock = detections.every((d) => d.detectedAt !== at.toISOString());
    record(
      'every detection is stamped with the bar it matched on',
      allOnBar,
      detections.map((d) => `${d.strategyId}@${d.detectedAt}`).join(' '),
    );
    record(
      'no detection carries the scan clock as its market time',
      noneOnScanClock,
      `scanClock=${at.toISOString()}`,
    );
    record(
      'execution time is retained separately',
      detections.every((d) => d.observedAt === at.toISOString()),
      `observedAt=${detections[0].observedAt ?? '-'}`,
    );
  }

  await app.close();
  report();
}

function report(): void {
  console.log('');
  for (const r of results) {
    console.log(`  ${r.verdict}  ${r.label}`);
    console.log(`        ${r.detail}`);
  }
  console.log('');
  console.log(`${passes} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('verification harness failed to run:', err);
  process.exitCode = 1;
});
