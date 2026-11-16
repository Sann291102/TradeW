/**
 * Make sure the dev Postgres is up before any service that needs it starts.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `npm run start:all` spawns every service at once. When the Docker Postgres
 * container is not running (Docker Desktop was not started after a reboot, or
 * the container was stopped), two services die on their own:
 *
 *   - API Backend   — scripts/preflight.mjs exits 1: "Postgres is not accepting
 *                     connections on localhost:5433".
 *   - Sentinel Python — asyncpg `Connect call failed ('127.0.0.1', 5433)`, and
 *                     it then sits there until the 120s readiness timeout.
 *
 * The fix was always one command (`docker compose ... up -d postgres`), but it
 * was printed only inside one service's log tail, after two minutes. This step
 * runs that command up front and waits for the container to be healthy, so the
 * services never race a database that is not there yet.
 *
 * It only acts on the compose-managed Postgres (a local host on the port the
 * compose file publishes). A DATABASE_URL pointing anywhere else is somebody's
 * own database — that is checked for reachability only, never "fixed".
 *
 * Exit 0: Postgres is reachable. Exit 1: it is not, with the reason and fix.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join('infra', 'docker', 'docker-compose.yml');
const CONTAINER = 'tradew-postgres';
const COMPOSE_PORT = 5433; // `ports: '5433:5432'` in the compose file
const WAIT_MS = 90_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const log = (msg) => console.log(`[POSTGRES] ${msg}`);

function readDatabaseUrl() {
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('DATABASE_URL=')) {
        return t.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return process.env.DATABASE_URL ?? '';
}

function canConnect(host, port, timeoutMs = 2000) {
  return new Promise((done) => {
    const socket = new net.Socket();
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** `docker` with no shell, so arguments are not re-parsed. Never throws. */
function docker(args) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}

function fail(message) {
  console.error(`\n[POSTGRES] ✗ ${message}\n`);
  process.exit(1);
}

let host = 'localhost';
let port = COMPOSE_PORT;
const url = readDatabaseUrl();
if (url) {
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port || 5432);
  } catch {
    fail(`DATABASE_URL is not a valid URL: ${url}`);
  }
}

if (await canConnect(host, port)) {
  log(`already reachable on ${host}:${port}`);
  process.exit(0);
}

if (!LOCAL_HOSTS.has(host) || port !== COMPOSE_PORT) {
  fail(
    `Postgres is not reachable on ${host}:${port}. That is not the Docker database from ` +
      `${COMPOSE_FILE} (localhost:${COMPOSE_PORT}), so it will not be started automatically — start it yourself.`,
  );
}

log(`not reachable on ${host}:${port} — starting the Docker container...`);

const info = docker(['info', '--format', '{{.ServerVersion}}']);
if (info.missing) {
  fail('Docker is not installed or not on PATH. Install Docker Desktop, then re-run.');
}
if (!info.ok) {
  fail(
    'Docker is installed but its engine is not running. Start Docker Desktop, wait until it says ' +
      '"Engine running", then re-run.\n  ' +
      info.out.split('\n').slice(-1)[0],
  );
}

const up = docker(['compose', '-f', COMPOSE_FILE, 'up', '-d', 'postgres']);
if (!up.ok) {
  fail(`\`docker compose up -d postgres\` failed:\n${up.out}`);
}

// A published port can accept TCP before Postgres is ready (Docker's proxy
// listens first), so prefer the container's own healthcheck; fall back to the
// port alone if the health status is unavailable.
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  const h = docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', CONTAINER]);
  const status = h.ok ? h.out : 'unknown';
  if (status === 'healthy' || ((status === 'none' || status === 'unknown') && (await canConnect(host, port)))) {
    log(`ready on ${host}:${port}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

fail(
  `Container ${CONTAINER} did not become healthy within ${WAIT_MS / 1000}s. ` +
    `Check: docker logs ${CONTAINER}`,
);
