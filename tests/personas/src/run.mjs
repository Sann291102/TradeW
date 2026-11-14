// Runs every persona against the app and writes findings Claude can act on.
//
//   node src/run.mjs                      all personas
//   node src/run.mjs new-trader           just one
//
// Environment:
//   PERSONA_BASE_URL   default http://localhost:3100  (the ISOLATED stack — see README)
//   PERSONA_HEADED=1   watch it happen
//
// Output (gitignored): out/<run-id>/{report.md,findings.json,screenshots/,accounts.json}
// and out/latest/ — a copy of the newest run, which the next run compares against.

import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { istStamp } from './findings.mjs';
import { runPersona } from './runner.mjs';
import { compareWithPrevious, renderReport } from './report.mjs';
import newTrader from './personas/newTrader.mjs';
import optionsTrader from './personas/optionsTrader.mjs';
import housekeeping from './personas/housekeeping.mjs';
import agentWatcher from './personas/agentWatcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const baseUrl = (process.env.PERSONA_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const ALL = [newTrader, optionsTrader, housekeeping, agentWatcher];
const only = process.argv.slice(2);
const personas = only.length ? ALL.filter((p) => only.includes(p.name)) : ALL;

// Refuse to run against anything that is not an explicitly local app: these
// personas create accounts and press Reset.
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(baseUrl)) {
  console.error(`Refusing to run against ${baseUrl}: virtual customers sign up and reset balances, so they only run against a local app.`);
  process.exit(2);
}

const stamp = istStamp();
const runId = stamp.iso.replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(ROOT, 'out', runId);
mkdirSync(outDir, { recursive: true });

// One generated account per persona: random, local-only, written to the
// run's gitignored folder — never printed and never reused across runs.
const accountMap = new Map(
  personas.map((p) => [p.name, { email: `${p.name}.${runId.toLowerCase()}@tradew.local`, password: `Pw-${randomBytes(9).toString('base64url')}` }]),
);
writeFileSync(join(outDir, 'accounts.json'), JSON.stringify(Object.fromEntries(accountMap), null, 2));
const accounts = { get: (name) => accountMap.get(name) };

// A dev server compiles each route on its first request, which can take a
// minute and would show up as a "slow page" finding that is really the dev
// server warming up. Visit each route once, off the record, first.
const WARM_ROUTES = ['/', '/login', '/dashboard', '/trade', '/orders', '/positions', '/portfolio', '/settings/trading'];
console.log('Warming routes (dev server compiles on first visit)…');
for (const route of WARM_ROUTES) {
  try {
    await fetch(`${baseUrl}${route}`, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    console.log(`  ! ${route}: ${err.message}`);
  }
}

// The dev API restarts whenever its sources change; starting a journey into a
// restart would report the restart as a product failure.
const apiOrigin = process.env.PERSONA_API_URL ?? baseUrl.replace(/:3100$/, ':4100');
async function waitForApi() {
  for (let i = 0; i < 24; i++) {
    try {
      const res = await fetch(`${apiOrigin}/auth/methods`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`  ! the API at ${apiOrigin} did not come up within 2 minutes; continuing — expect environment blocks.`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.PERSONA_HEADED !== '1' });
const steps = [];
try {
  for (const persona of personas) {
    await waitForApi();
    console.log(`▶ ${persona.title}`);
    const result = await runPersona(persona, { browser, baseUrl, outDir, accounts });
    for (const s of result) console.log(`   ${{ pass: '✅', finding: '🟠', blocked: '⚪', 'not-reached': '⏭️' }[s.status]} ${s.step}`);
    steps.push(...result);
  }
} finally {
  await browser.close();
}

const findings = steps.flatMap((s) =>
  (s.findings ?? []).map((f) => ({ ...f, persona: s.persona, step: s.step, route: f.where ?? s.route, screenshot: s.screenshot })),
);
// The same problem seen on two steps is one finding.
const unique = [...new Map(findings.map((f) => [f.id, f])).values()];
const environment = steps
  .filter((s) => s.status === 'blocked')
  .map((s) => ({ persona: s.persona, step: s.step, reason: s.environmentReason ?? 'environment' }));

const latestDir = join(ROOT, 'out', 'latest');
const trend = compareWithPrevious(join(latestDir, 'findings.json'), unique, personas.map((p) => p.name));
const run = { id: runId, stamp, baseUrl };
writeFileSync(join(outDir, 'findings.json'), JSON.stringify({ run, trend, findings: unique, environment, steps }, null, 2));
writeFileSync(join(outDir, 'report.md'), renderReport({ run, steps, findings: unique, environment, trend, personas }));

if (existsSync(latestDir)) rmSync(latestDir, { recursive: true, force: true });
cpSync(outDir, latestDir, { recursive: true });

const n = (s) => steps.filter((x) => x.status === s).length;
console.log(`\n${steps.length} steps: ${n('pass')} passed, ${n('finding')} with findings, ${n('blocked')} blocked by the environment, ${n('not-reached')} not reached.`);
console.log(`Report: ${join(outDir, 'report.md')}`);
