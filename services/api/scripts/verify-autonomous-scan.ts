/**
 * "Can the bot find its own setups, on all three markets, with Sentinel off?"
 *
 *   npm run verify:autonomous-scan -w @tradew/api
 *
 * ## What this proves
 *
 * That India, BTC and Gold all reach the SAME decision layer through their own
 * data source, against LIVE data, with no Sentinel involved at any point. It
 * prints what the engine saw and what it decided for each — including the
 * refusals, with the reason and the numbers behind them.
 *
 * ## It never places an order
 *
 * The scanner has no order path in this phase. Every call here is a read and a
 * pure computation, and the engine's own master switch is set for this process
 * only — it is not written to `.env` and it does not persist.
 *
 * ## A WAIT is a pass, not a failure
 *
 * The expected result on most runs is that no setup validates. That is the
 * engine working. What this script is checking is that the pipeline RUNS end
 * to end for each market — data arrives, features build, setups are evaluated,
 * levels are attempted, and a reasoned decision comes out. A market that
 * reports `data-unavailable` is the real failure.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

// Set BEFORE the scanner is imported/constructed. Process-local: this turns
// the engine on for this script only and writes nothing.
process.env.AUTONOMOUS_ENGINE_ENABLED = 'true';

import { DhanBridgeSource } from '../src/autonomous/dhan-bridge.source';
import { BinanceSource } from '../src/autonomous/binance.source';
import { SetupScannerService, type ScanResult } from '../src/autonomous/setup-scanner.service';
import { REJECTION_LABELS } from '@tradew/strategy-core';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

/** One instrument per market — the three the brief names. */
const TARGETS = [
  { symbol: 'NIFTY', label: 'INDIA  (NSE index options)' },
  { symbol: 'BTCUSDT', label: 'CRYPTO (Binance spot)' },
  { symbol: 'GOLD', label: 'GOLD   (MCX futures)' },
];

function line(char = '─', n = 72): string {
  return char.repeat(n);
}

function renderCandidate(c: ScanResult['candidates'][number], indent = '     '): void {
  const verdict = c.accepted ? `${GREEN}ACCEPTED${RESET}` : `${YELLOW}REJECTED${RESET}`;
  console.log(`${indent}${verdict}  ${BOLD}${c.setupName}${RESET} ${DIM}(${c.setupId} v${c.setupVersion})${RESET}`);
  console.log(`${indent}  bias=${c.bias} quality=${c.quality} archetype=${c.archetype}`);

  if (c.plan) {
    const p = c.plan;
    console.log(
      `${indent}  ${BOLD}entry ${p.entry}  stop ${p.stop}  target ${p.target}${RESET}` +
        `  ${DIM}(risk ${p.riskPerUnit} = ${p.riskAtr} ATR, reward ${p.rewardPerUnit}, ${p.plannedRR}R)${RESET}`,
    );
    console.log(`${indent}  anchor: ${p.anchor.note}`);
  }

  if (!c.accepted && c.rejectionReason) {
    const label = REJECTION_LABELS[c.rejectionReason] ?? c.rejectionReason;
    console.log(`${indent}  ${YELLOW}why not:${RESET} [${c.rejectionReason}] ${label}`);
    if (c.rejectionDetail) console.log(`${indent}    ${DIM}${c.rejectionDetail}${RESET}`);
  }

  console.log(`${indent}  ${DIM}${c.explanation}${RESET}`);
  console.log('');
}

async function main(): Promise<void> {
  console.log('');
  console.log(line('═'));
  console.log('  AUTONOMOUS SCAN — live data, shared decision core, Sentinel absent');
  console.log(line('═'));
  console.log(`  ${DIM}AUTONOMOUS_ENGINE_ENABLED=true (this process only)${RESET}`);
  console.log(`  ${DIM}No Sentinel client is constructed anywhere below.${RESET}`);
  console.log('');

  const scanner = new SetupScannerService(new DhanBridgeSource(), new BinanceSource());
  const now = new Date();
  const results: ScanResult[] = [];

  for (const target of TARGETS) {
    console.log(line());
    console.log(`${BOLD}${target.label}${RESET}  —  ${target.symbol}`);
    console.log(line());

    const result = await scanner.scanSymbol(target.symbol, now);
    results.push(result);

    if (result.status !== 'scanned') {
      const colour = result.status === 'data-unavailable' ? RED : YELLOW;
      console.log(`  ${colour}${result.status}${RESET} — ${result.detail}`);
      console.log('');
      continue;
    }

    console.log(
      `  ${GREEN}scanned${RESET}  source=${result.source}  ` +
        `data age=${result.dataAgeSeconds}s  candidates=${result.candidates.length}`,
    );
    console.log('');

    if (result.candidates.length === 0) {
      console.log(`  ${DIM}No setup came within one rule of validating. The market offered`);
      console.log(`  nothing, and an empty result is what that correctly looks like.${RESET}`);
      console.log('');
      continue;
    }

    for (const c of result.candidates) renderCandidate(c);
  }

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(line('═'));
  console.log('  SUMMARY');
  console.log(line('═'));

  let reachedDecisionLayer = 0;
  for (const r of results) {
    const accepted = r.candidates.filter((c) => c.accepted).length;
    const rejected = r.candidates.length - accepted;
    const ok = r.status === 'scanned';
    if (ok) reachedDecisionLayer += 1;

    const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(
      `  ${mark} ${(r.market ?? '—').padEnd(7)} ${r.symbol.padEnd(9)} ` +
        `${r.status.padEnd(18)} ${ok ? `${accepted} accepted, ${rejected} rejected` : (r.detail ?? '')}`,
    );
  }

  // A CLOSED venue is not a failure. This script exists to prove the pipeline
  // runs for each market, and a market that is shut has nothing to run against
  // — reporting that as a non-zero exit made the result depend on the clock,
  // so a green run out of hours was impossible and CI would read a normal
  // evening as a broken engine.
  const closed = results.filter((r) => r.status === 'skipped-closed');
  const reachable = results.filter((r) => r.status !== 'skipped-closed');
  const failed = reachable.filter((r) => r.status !== 'scanned');

  console.log('');
  console.log(
    `  ${reachedDecisionLayer}/${reachable.length} OPEN markets reached the shared decision layer` +
      (closed.length ? `, ${closed.length} closed (not a failure).` : '.'),
  );

  const anyAccepted = results.some((r) => r.candidates.some((c) => c.accepted));
  if (!anyAccepted) {
    console.log('');
    console.log(`  ${DIM}No trade was accepted on this pass. That is the DESIGNED RESTING`);
    console.log(`  STATE, not a fault — the engine waits until a setup validates and`);
    console.log(`  its levels clear the 1:3 filter. Nothing here lowers a threshold to`);
    console.log(`  produce a result.${RESET}`);
  }
  console.log('');

  // A market that was OPEN and could not be reached is the only failure.
  if (failed.length) {
    console.log(`  ${RED}FAILED:${RESET} ${failed.map((f) => `${f.symbol} (${f.status})`).join(', ')}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}verification failed:${RESET}`, err);
  process.exit(1);
});
