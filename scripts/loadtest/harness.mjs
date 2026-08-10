/**
 * A small closed-loop load generator for the TradeW stack.
 *
 * WHY THIS EXISTS RATHER THAN k6/artillery
 *
 * Nothing here is beyond what k6 does — it is here because a load test whose
 * results anyone is expected to act on has to be reproducible by whoever reads
 * the report, and "first install k6" is a step that does not survive contact
 * with a laptop that has no package manager. This runs on the Node the repo
 * already requires, with no dependencies at all. If the suite outgrows that
 * (distributed generation, browser-level timings), move to k6 and delete this.
 *
 * WHAT IT MEASURES, AND WHAT THAT NUMBER MEANS
 *
 * Closed-loop, not open-loop: a fixed population of virtual users each run a
 * journey, wait a think time, and repeat. That models N people using the app,
 * which is what a "500 concurrent users" target actually means — as opposed to
 * an open-loop generator that fires a fixed arrival rate regardless of whether
 * the server is keeping up, and reports a queue rather than a capacity.
 *
 * The consequence is worth stating because it is easy to misread: under a
 * closed-loop model, a slower server produces FEWER requests per second, not a
 * growing backlog. So throughput falling while latency rises is the system
 * saturating, and the honest capacity number is the largest VU count at which
 * the latency target still holds — not the peak RPS observed anywhere.
 *
 * Percentiles are computed from every recorded sample, not from a reservoir:
 * runs here are minutes long, so the full array costs a few MB and removes a
 * whole class of "is the p99 real?" question from the report.
 */

import { performance } from 'node:perf_hooks';
import http from 'node:http';
import https from 'node:https';

// ---------------------------------------------------------------- HTTP client

/**
 * Keep-alive is not an optimisation here, it is a correctness requirement: a
 * fresh TCP connection per request would measure connection setup and ephemeral
 * port exhaustion on the LOAD GENERATOR, and report it as server latency. Real
 * browsers hold connections open, so the test does too.
 */
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 30_000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 30_000 }),
};

/**
 * One request. Resolves with an outcome record — it never rejects, because a
 * connection error IS a result and losing it would flatter the numbers.
 */
export function request({ url, method = 'GET', headers = {}, body = null, timeoutMs = 30_000 }) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

  const started = performance.now();
  return new Promise((resolve) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        agent: agents[target.protocol],
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        // The body must be consumed even when it is not used, or the socket is
        // never released back to the keep-alive pool and the run deadlocks
        // after `maxSockets` requests.
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            ms: performance.now() - started,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) =>
      resolve({ ok: false, status: 0, ms: performance.now() - started, error: err.message, body: '' }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------------- recording

export class Recorder {
  constructor() {
    /** step name -> { samples: number[], statuses: Map, errors: Map } */
    this.steps = new Map();
    this.startedAt = 0;
    this.endedAt = 0;
  }

  step(name) {
    let s = this.steps.get(name);
    if (!s) {
      s = { samples: [], statuses: new Map(), errors: new Map() };
      this.steps.set(name, s);
    }
    return s;
  }

  record(name, result) {
    const s = this.step(name);
    s.samples.push(result.ms);
    s.statuses.set(result.status, (s.statuses.get(result.status) ?? 0) + 1);
    if (result.error) s.errors.set(result.error, (s.errors.get(result.error) ?? 0) + 1);
  }

  summary() {
    const durationSec = (this.endedAt - this.startedAt) / 1000;
    const rows = [];
    let total = 0;
    let failures = 0;

    for (const [name, s] of [...this.steps.entries()].sort()) {
      const sorted = [...s.samples].sort((a, b) => a - b);
      const n = sorted.length;
      total += n;
      // 2xx/3xx is success. 429 is counted separately and NOT as an error:
      // being throttled is the rate limiter working, and folding it into the
      // error rate would make a correctly-defended service look broken.
      const throttled = s.statuses.get(429) ?? 0;
      const bad = [...s.statuses.entries()]
        .filter(([code]) => code === 0 || code >= 500 || (code >= 400 && code !== 429))
        .reduce((acc, [, c]) => acc + c, 0);
      failures += bad;

      rows.push({
        step: name,
        n,
        rps: durationSec > 0 ? n / durationSec : 0,
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        max: n ? sorted[n - 1] : 0,
        throttled,
        failed: bad,
        statuses: Object.fromEntries([...s.statuses.entries()].sort((a, b) => a[0] - b[0])),
        errors: Object.fromEntries(s.errors.entries()),
      });
    }

    return { durationSec, totalRequests: total, failures, rps: durationSec > 0 ? total / durationSec : 0, rows };
  }
}

/** Nearest-rank percentile. No interpolation — with thousands of samples the
 *  difference is noise, and the rank is the value an operator can point at. */
function pct(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

// --------------------------------------------------------------------- running

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Jittered think time. Without jitter every virtual user marches in lockstep
 *  and produces a synthetic thundering herd that no real population exhibits. */
export const think = (baseMs, spreadMs = baseMs * 0.5) =>
  sleep(Math.max(0, baseMs + (Math.random() * 2 - 1) * spreadMs));

/**
 * Ramp a population of virtual users up to `vus` over `rampSeconds`, hold for
 * `holdSeconds`, then stop.
 *
 * The ramp is not cosmetic: starting 500 users simultaneously measures a cold
 * connection pool and a cold JIT, which is a real but different question from
 * "how does this behave at steady state". Metrics are recorded across the whole
 * run and the report says which phase a number came from.
 */
export async function run({ vus, rampSeconds, holdSeconds, journey, recorder, onProgress }) {
  recorder.startedAt = performance.now();
  const deadline = recorder.startedAt + (rampSeconds + holdSeconds) * 1000;
  let stop = false;
  let active = 0;

  const worker = async (id) => {
    active += 1;
    while (!stop && performance.now() < deadline) {
      try {
        await journey({ id, recorder });
      } catch (err) {
        // A journey that throws is a bug in the journey, not a server result.
        // Surface it rather than silently reducing the load.
        recorder.record('journey:error', { ms: 0, status: 0, error: String(err?.message ?? err) });
      }
    }
    active -= 1;
  };

  const workers = [];
  const gapMs = vus > 0 ? (rampSeconds * 1000) / vus : 0;
  const progress = onProgress
    ? setInterval(() => onProgress({ active, elapsedSec: (performance.now() - recorder.startedAt) / 1000 }), 5_000)
    : null;

  for (let i = 0; i < vus; i += 1) {
    workers.push(worker(i));
    if (gapMs > 0) await sleep(gapMs);
    if (performance.now() >= deadline) break;
  }

  await Promise.all(workers);
  stop = true;
  if (progress) clearInterval(progress);
  recorder.endedAt = performance.now();
}

// --------------------------------------------------------------------- output

export function renderTable(summary) {
  const head = ['step', 'n', 'rps', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', '429', 'fail'];
  const body = summary.rows.map((r) => [
    r.step,
    String(r.n),
    r.rps.toFixed(1),
    r.p50.toFixed(1),
    r.p95.toFixed(1),
    r.p99.toFixed(1),
    r.max.toFixed(0),
    String(r.throttled),
    String(r.failed),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
