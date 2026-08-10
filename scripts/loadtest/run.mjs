/**
 * TradeW load test runner.
 *
 *   node scripts/loadtest/run.mjs --vus 500 --ramp 60 --hold 180
 *
 * Flags:
 *   --vus N        virtual users at full ramp (default 100)
 *   --ramp SEC     seconds to reach that population (default 30)
 *   --hold SEC     seconds to hold it (default 120)
 *   --api URL      API base           (default http://127.0.0.1:4000)
 *   --web URL      web base           (default http://127.0.0.1:3000)
 *   --mix NAME     `full` (default), `read`, `auth`, `sentinel`
 *   --json PATH    also write the raw summary as JSON
 *
 * The population is split across journeys in proportions meant to look like a
 * real trading-app session mix rather than to maximise a number:
 *
 *   45%  dashboard   — the default landing surface; polls on a timer
 *   20%  portfolio   — user-scoped reads, the least cacheable work in the app
 *   15%  learning    — read-heavy and highly cacheable
 *   10%  anonymous   — visitors on the marketing page who never sign in
 *    7%  trading     — placing and cancelling orders
 *    3%  sentinel    — the premium reasoning path (see journeys.mjs)
 *
 * ACCOUNTS: every signed-in journey needs a real account. The runner creates
 * `--accounts` of them up front (default 25) and shares them across virtual
 * users, because a distinct account per VU would spend the whole ramp inside
 * bcrypt and the auth rate limiter rather than testing the app.
 */

import { writeFileSync } from 'node:fs';
import { Recorder, renderTable, request, run } from './harness.mjs';
import * as J from './journeys.mjs';

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? 'http://127.0.0.1:4000';
const WEB = args.web ?? 'http://127.0.0.1:3000';
const VUS = Number(args.vus ?? 100);
const RAMP = Number(args.ramp ?? 30);
const HOLD = Number(args.hold ?? 120);
const ACCOUNTS = Number(args.accounts ?? 25);
const MIX = args.mix ?? 'full';
const PASSWORD = args.password ?? 'LoadTest!2026x';

const MIXES = {
  full: { dashboard: 0.45, portfolio: 0.2, learning: 0.15, anonymous: 0.1, trading: 0.07, sentinel: 0.03 },
  read: { dashboard: 0.6, portfolio: 0.25, learning: 0.15 },
  auth: { anonymous: 1 },
  sentinel: { sentinel: 1 },
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  console.log(`TradeW load test — ${VUS} VUs, ramp ${RAMP}s, hold ${HOLD}s, mix "${MIX}"`);
  console.log(`  api ${API}\n  web ${WEB}\n`);

  await assertUp();

  const mix = MIXES[MIX];
  if (!mix) throw new Error(`unknown mix "${MIX}" — one of ${Object.keys(MIXES).join(', ')}`);

  const needsAuth = Object.keys(mix).some((k) => k !== 'anonymous');
  const accounts = needsAuth ? await provisionAccounts(Math.min(ACCOUNTS, Math.max(1, VUS))) : [];
  if (needsAuth && accounts.length === 0) {
    throw new Error('could not sign in any account — check the API is reachable and not rate limiting the runner');
  }
  if (needsAuth) console.log(`signed in ${accounts.length} account(s)\n`);

  // One tradable symbol for the trading journey, resolved once from real data
  // so the test never invents a symbol the API would reject for the wrong
  // reason — a 400 on every order looks exactly like a load failure in the
  // summary table, and is not one.
  const symbol = needsAuth ? await resolveSymbol(accounts[0].token) : null;
  if (mix.trading && !symbol) {
    console.warn('! no tradable symbol resolved — the trading journey will be skipped\n');
  }

  const recorder = new Recorder();
  const journeys = buildPopulation({ mix, accounts, symbol });

  console.log('population:');
  for (const [name, count] of Object.entries(countByName(journeys))) console.log(`  ${count.toString().padStart(4)}  ${name}`);
  console.log('');

  let i = 0;
  await run({
    vus: journeys.length,
    rampSeconds: RAMP,
    holdSeconds: HOLD,
    recorder,
    journey: async (ctx) => journeys[ctx.id % journeys.length].fn(ctx),
    onProgress: ({ active, elapsedSec }) =>
      console.log(`  t+${elapsedSec.toFixed(0).padStart(4)}s  active VUs ${active}`),
  });

  const summary = recorder.summary();
  console.log('\n' + renderTable(summary));
  console.log(
    `\ntotal ${summary.totalRequests} requests in ${summary.durationSec.toFixed(1)}s ` +
      `= ${summary.rps.toFixed(1)} rps · failures ${summary.failures} ` +
      `(${((summary.failures / Math.max(1, summary.totalRequests)) * 100).toFixed(2)}%)`,
  );

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ config: { API, WEB, VUS, RAMP, HOLD, MIX }, summary }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
  i; // silence unused in some linters
}

/** Fail fast and clearly rather than reporting a run of connection errors. */
async function assertUp() {
  const api = await request({ url: `${API}/health`, timeoutMs: 5_000 });
  if (!api.ok) throw new Error(`API not reachable at ${API}/health (status ${api.status} ${api.error ?? ''})`);
  const web = await request({ url: `${WEB}/`, timeoutMs: 10_000 });
  if (!web.ok) console.warn(`! web not reachable at ${WEB}/ (status ${web.status}) — anonymous journey will fail`);
}

/**
 * Create (or re-use) load-test accounts.
 *
 * Signup is rate limited, so accounts are created slowly and a 429 is treated
 * as "this one already exists, just sign in" rather than as a failure — which
 * is what makes a second run of the test cheap.
 */
async function provisionAccounts(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const email = `loadtest+${i}@tradew.local`;
    await request({ url: `${API}/auth/signup`, method: 'POST', body: { email, password: PASSWORD } });
    const res = await request({ url: `${API}/auth/login`, method: 'POST', body: { email, password: PASSWORD } });
    if (res.ok) {
      try {
        out.push({ email, token: JSON.parse(res.body).accessToken });
      } catch {
        /* fall through */
      }
    }
    // Stay under the auth limiter while provisioning. This is setup, not load.
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/** Prefers an exact match: a search for RELIANCE returns RCOM first, and
 *  ordering the load test's behaviour by search relevance is a way to get a
 *  different instrument on a different day. */
async function resolveSymbol(token) {
  const res = await request({
    url: `${API}/instruments/search?q=RELIANCE`,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  try {
    const list = JSON.parse(res.body);
    const items = Array.isArray(list) ? list : (list?.items ?? []);
    const exact = items.find((i) => i.symbol === 'RELIANCE');
    return (exact ?? items[0])?.symbol ?? null;
  } catch {
    return null;
  }
}

function buildPopulation({ mix, accounts, symbol }) {
  const out = [];
  const pick = (i) => accounts[i % Math.max(1, accounts.length)];

  for (const [name, share] of Object.entries(mix)) {
    const count = Math.max(0, Math.round(share * VUS));
    for (let i = 0; i < count; i += 1) {
      const acct = pick(out.length);
      if (name === 'anonymous') out.push({ name, fn: J.anonymousLanding({ webBase: WEB }) });
      else if (!acct) continue;
      else if (name === 'dashboard') out.push({ name, fn: J.dashboard({ apiBase: API, token: acct.token }) });
      else if (name === 'portfolio') out.push({ name, fn: J.portfolio({ apiBase: API, token: acct.token }) });
      else if (name === 'learning') out.push({ name, fn: J.learning({ apiBase: API, token: acct.token }) });
      else if (name === 'sentinel') out.push({ name, fn: J.sentinel({ apiBase: API, token: acct.token }) });
      else if (name === 'trading' && symbol)
        out.push({ name, fn: J.trading({ apiBase: API, token: acct.token, symbol }) });
    }
  }
  return out;
}

function countByName(journeys) {
  const counts = {};
  for (const j of journeys) counts[j.name] = (counts[j.name] ?? 0) + 1;
  return counts;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}
