/**
 * Fail loudly, at startup, for the configuration faults that otherwise surface
 * as an unexplained HTTP 500 in the browser.
 *
 * ── THE FAILURE THIS EXISTS FOR ───────────────────────────────────────────
 *
 * Reported as "login returns 500". The browser showed 500 on three routes:
 *
 *     GET  /api/auth/methods
 *     POST /api/auth/login
 *     GET  /api/ai/persona/suggestions
 *
 * Two of those cannot fail: `/auth/methods` returns three booleans read from
 * `process.env`, and `/ai/persona/suggestions` returns a compile-time constant
 * array. Neither touches the database, a guard, or any I/O. A handler that
 * returns a literal cannot throw — so the 500 was never produced by these
 * endpoints at all.
 *
 * It was produced by the PROXY. `/api/*` is a Next.js rewrite to services/api
 * (apps/web/next.config.mjs). With nothing listening on the far end, Next logs
 * `Failed to proxy http://127.0.0.1:4000/... Error: connect ECONNREFUSED` and
 * answers the browser with a bare HTML 500. Every `/api/*` call fails
 * identically and none of them says why, because the reason is in a different
 * terminal.
 *
 * And the reason services/api was not listening is upstream of that again: a
 * fresh clone has no root `.env` (it is gitignored; only `.env.example` is
 * committed), so `app.module.ts` throws on `JWT_SECRET is not set` at module
 * load and the process exits 1 before it ever binds port 4000.
 *
 * That chain is four hops long and every hop is silent in the place you are
 * looking. This script collapses it to one message, printed before the server
 * starts, naming the file to create and the command to run.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 *
 * It checks PRESENCE and REACHABILITY, not secret strength. The authority on
 * whether a secret is acceptable stays `services/api/src/common/
 * secret-validation.ts` — duplicating those rules here would create a second
 * source of truth that drifts. This answers "is this environment wired up at
 * all", which is the question the 500 above was really asking.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

const problems = [];
const notes = [];

function fail(title, detail) {
  problems.push({ title, detail });
}

// ---------------------------------------------------------------- root .env

if (!existsSync(ENV_PATH)) {
  fail(
    'No .env at the repo root.',
    [
      'Every service reads this one file (services/api resolves it by absolute',
      'path in src/main.ts). Without it services/api exits before it can listen,',
      'and every /api/* call in the browser becomes an unexplained 500.',
      '',
      '  cp .env.example .env',
      '',
      'Then fill in JWT_SECRET (and DATABASE_URL if not using the default):',
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    ].join('\n'),
  );
}

/**
 * Parse `.env` directly rather than importing dotenv into the caller's env.
 * A preflight that mutates process.env would change the very thing it reports
 * on, and it must be able to say "this variable is missing from the FILE" even
 * when the same name happens to be exported in the calling shell.
 */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = readEnvFile(ENV_PATH);
const valueOf = (name) => (env[name] ?? process.env[name] ?? '').trim();

// ------------------------------------------------------- required variables

/**
 * The two without which services/api cannot serve a single request. Both are
 * hard failures in the service itself; listing them here only moves the
 * discovery earlier and into the terminal the developer is already reading.
 */
const REQUIRED = [
  {
    name: 'JWT_SECRET',
    why: 'signs every session token; services/api refuses to boot without it',
    remedy: 'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  },
  {
    name: 'DATABASE_URL',
    why: 'every persistent read and write, sign-in included',
    remedy: 'postgresql://tradew:tradew@localhost:5433/tradew  (matches infra/docker/docker-compose.yml)',
  },
];

for (const { name, why, remedy } of REQUIRED) {
  if (!valueOf(name)) {
    fail(`${name} is not set.`, `Needed for: ${why}.\n\n  ${remedy}`);
  }
}

// ------------------------------------------------------ database reachability

/** Resolve host/port from a postgres URL without pulling in a driver. */
function parsePostgresUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 5432) };
  } catch {
    return null;
  }
}

function canConnect(host, port, timeoutMs = 2500) {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

const databaseUrl = valueOf('DATABASE_URL');
if (databaseUrl) {
  const target = parsePostgresUrl(databaseUrl);
  if (!target) {
    fail('DATABASE_URL is not a valid URL.', `Got: ${databaseUrl}`);
  } else if (!(await canConnect(target.host, target.port))) {
    fail(
      `Postgres is not accepting connections on ${target.host}:${target.port}.`,
      [
        'Start it:',
        '',
        '  docker compose -f infra/docker/docker-compose.yml up -d postgres',
        '',
        'A common trap: the compose file publishes 5433 on the host, so a',
        'DATABASE_URL pointing at 5432 silently reaches a DIFFERENT Postgres',
        'if one happens to be running locally.',
      ].join('\n'),
    );
  } else {
    notes.push(`postgres reachable on ${target.host}:${target.port}`);

    // Migrations. The same drift that makes `user.findUnique` throw P2022 and
    // turns sign-in into a 500 — worth catching before the server starts, not
    // on the first login attempt.
    try {
      const require = createRequire(import.meta.url);
      const { MIGRATION_NAMES } = require('@tradew/database');
      if (Array.isArray(MIGRATION_NAMES) && MIGRATION_NAMES.length) {
        notes.push(`${MIGRATION_NAMES.length} migrations shipped by @tradew/database`);
      }
    } catch {
      // The package may not be built yet on a first run; services/api performs
      // the authoritative comparison against _prisma_migrations at boot.
    }
  }
}

// ------------------------------------------------------------------- report

const RED = '[31m';
const YELLOW = '[33m';
const GREEN = '[32m';
const DIM = '[2m';
const RESET = '[0m';

if (problems.length === 0) {
  console.log(`${GREEN}✓ preflight${RESET} ${DIM}${notes.join(' · ')}${RESET}`);
  process.exit(0);
}

console.error('');
console.error(`${RED}✗ TradeW preflight failed — ${problems.length} problem(s).${RESET}`);
console.error(
  `${DIM}Fixing these now avoids an unexplained HTTP 500 on every /api/* call later.${RESET}`,
);
for (const [i, { title, detail }] of problems.entries()) {
  console.error('');
  console.error(`${YELLOW}${i + 1}. ${title}${RESET}`);
  console.error(
    detail
      .split('\n')
      .map((l) => `   ${l}`)
      .join('\n'),
  );
}
console.error('');
process.exit(1);
