import { spawn, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync, readSync, openSync, closeSync, fstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as http from 'node:http';
import net from 'node:net';

const ROOT = resolve(process.cwd());
const LOGS_DIR = join(ROOT, '.logs');
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

// 1. Clean up any existing listeners on our ports
function killExistingProcesses() {
  console.log('[CLEANUP] Freeing ports and stopping existing tunnel/dev processes...');
  try {
    if (process.platform === 'win32') {
      try {
        execSync('taskkill /F /IM cloudflared.exe /T', { stdio: 'ignore' });
      } catch {}
      const targetPorts = [3000, 3001, 4000, 4010, 4011, 4020, 4600];
      const netstatOutput = execSync('netstat -ano', { encoding: 'utf8' });
      const pidsToKill = new Set();
      for (const line of netstatOutput.split('\n')) {
        for (const port of targetPorts) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = Number(parts[parts.length - 1]);
            if (pid && pid > 4 && pid !== process.pid) {
              pidsToKill.add(pid);
            }
          }
        }
      }
      for (const pid of pidsToKill) {
        try {
          execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
        } catch {}
      }
    }
  } catch (err) {
    // ignore
  }
}

const SERVICES = [
  {
    name: 'Live Feed (Market Data)',
    id: 'market-data',
    cmd: 'npm',
    args: ['run', 'dev:market-data'],
    port: 4600,
    healthPath: '/health',
    tunnel: false,
  },
  {
    name: 'API Backend',
    id: 'api',
    cmd: 'npm',
    args: ['run', 'dev:api'],
    port: 4000,
    healthPath: '/health',
    tunnel: false,
  },
  {
    name: 'Sentinel AI Service',
    id: 'sentinel',
    cmd: 'npm',
    args: ['run', 'dev:sentinel'],
    port: 4010,
    healthPath: '/health',
    tunnel: false,
  },
  {
    name: 'Sentinel Python',
    id: 'sentinel-py',
    cmd: 'npm',
    args: ['run', 'dev:sentinel-py'],
    port: 4011,
    // FastAPI/uvicorn service, not a Nest health controller — a bound port is
    // the readiness signal available here.
    healthPath: null,
    tunnel: false,
  },
  {
    name: 'TradeW AI Assistant',
    id: 'tradew-ai',
    cmd: 'npm',
    args: ['run', 'dev:ai'],
    port: 4020,
    healthPath: '/health',
    tunnel: false,
  },
  {
    name: 'Web Frontend',
    id: 'web',
    cmd: 'npm',
    args: ['run', 'dev:web'],
    port: 3000,
    // Next dev has no dedicated health route; any HTTP response (even a 404
    // while a route compiles) proves the listener is up and not crashed.
    healthPath: '/',
    tunnel: true,
  },
  {
    name: 'Admin Portal',
    id: 'admin',
    cmd: 'npm',
    args: ['run', 'dev:admin'],
    port: 3001,
    healthPath: '/health',
    tunnel: true,
  },
];

/**
 * Every service gets this long to bind its port and answer a health check
 * before startup is declared a failure. Generous because `dev:api` and the
 * Next apps compile TypeScript on first run — the exact case that used to
 * fail silently (37 compile errors, process exits, banner prints anyway).
 */
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

const processes = [];
const tunnelUrls = {};
/** @type {Map<string, { ready: boolean; failed: boolean; exitCode: number | null; exitSignal: string | null }>} */
const serviceState = new Map();

function startService(svc) {
  const logPath = join(LOGS_DIR, `${svc.id}.log`);
  const logStream = createWriteStream(logPath, { flags: 'w' });
  console.log(`[STARTING] ${svc.name} on port ${svc.port}...`);

  const proc = spawn(svc.cmd, svc.args, {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const state = { ready: false, failed: false, exitCode: null, exitSignal: null };
  serviceState.set(svc.id, state);

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on('error', (err) => {
    console.error(`[ERROR] ${svc.name}: ${err.message}`);
    state.failed = true;
  });

  proc.on('exit', (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
    if (!state.ready && (code !== 0 || signal)) {
      // Exiting before it ever became ready is exactly the failure mode this
      // launcher used to hide: it kept spawning the rest and printed a banner
      // with a URL for a process that was already dead.
      state.failed = true;
    } else if (code !== null && code !== 0) {
      console.log(`[WARN] ${svc.name} exited with code: ${code}`);
    }
  });

  processes.push({ name: svc.name, proc });
  return proc;
}

/** Read the last `n` lines of a log file without loading the whole thing. */
function tailLog(logPath, n = 25) {
  try {
    const fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const readSize = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, size - readSize);
    closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/** True once something is listening on `port` on 127.0.0.1. */
function isPortOpen(port, timeoutMs = 1500) {
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
    socket.connect(port, '127.0.0.1');
  });
}

/** True if an HTTP request to `path` on `port` gets ANY response — proves a
 *  live, non-crashed listener, not just an OS-level accept queue. */
function httpRespondsOk(port, path, timeoutMs = 2000) {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolvePromise(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolvePromise(false);
    });
    req.on('error', () => resolvePromise(false));
  });
}

/**
 * Poll until the service is genuinely ready (port bound, health check
 * passing) or genuinely dead (process exited) or the timeout elapses. This is
 * the fix for the actual bug reported: the previous version never checked
 * ANY of these three things and printed the banner regardless.
 */
async function waitUntilReady(svc) {
  const state = serviceState.get(svc.id);
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // A nonzero exit / signal is a real crash — fail fast. A clean `code 0`
    // exit is NOT: on Windows, `npm run <script>` spawned with shell:true can
    // hand off to a nested node process and return 0 itself while the real
    // dev server keeps running under that child. Only `state.failed` (set by
    // the exit handler using this same rule) is treated as fatal here — a
    // bare `exitCode !== null` check previously flagged that handoff as a
    // dead service even while Next was mid-compile and about to bind the
    // port, which is the false "Admin Portal — FAILED" seen in testing.
    if (state.failed) {
      return { ready: false, reason: `process exited (code ${state.exitCode}, signal ${state.exitSignal})` };
    }

    const portOpen = await isPortOpen(svc.port);
    if (portOpen) {
      if (!svc.healthPath) {
        state.ready = true;
        return { ready: true };
      }
      const healthy = await httpRespondsOk(svc.port, svc.healthPath);
      if (healthy) {
        state.ready = true;
        return { ready: true };
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (state.failed) {
    return { ready: false, reason: `process exited (code ${state.exitCode}, signal ${state.exitSignal})` };
  }
  return { ready: false, reason: `did not become ready within ${READY_TIMEOUT_MS / 1000}s` };
}

async function startCloudflareTunnel(svc) {
  console.log(`[TUNNEL] Creating Cloudflare tunnel for ${svc.name} (: ${svc.port})...`);
  const logPath = join(LOGS_DIR, `tunnel-${svc.id}.log`);
  writeFileSync(logPath, '');

  const proc = spawn('cloudflared', ['tunnel', '--logfile', logPath, '--url', `http://localhost:${svc.port}`], {
    shell: false,
    env: process.env,
  });

  proc.on('error', (err) => {
    console.warn(`[TUNNEL ERROR] Cloudflare tunnel for ${svc.name} failed: ${err.message}`);
  });

  processes.push({ name: `tunnel-${svc.id}`, proc });

  // Poll log file for tunnel URL
  const maxAttempts = 40; // 20 seconds
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, 'utf8');
        const match = content.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          const url = match[0];
          tunnelUrls[svc.id] = url;
          console.log(`[TUNNEL READY] ${svc.name} -> ${url}`);
          return url;
        }
      }
    } catch {}
  }

  console.warn(`[TUNNEL TIMEOUT] Could not retrieve tunnel URL for ${svc.name} within 20s.`);
  return null;
}

async function main() {
  console.log('====================================================');
  console.log('       TradeW Full Stack & Cloudflare Launcher      ');
  console.log('====================================================\n');

  // Rebuild any workspace package (@tradew/types, @tradew/database,
  // @tradew/ai-core, @tradew/market-data) whose dist/ is behind its src/,
  // BEFORE any service starts — see scripts/ensure-fresh-packages.mjs for why
  // this exists. Running it here, ahead of killExistingProcesses/spawn, means
  // a rebuild never races a sibling service that already loaded the Prisma
  // Client into memory (the Windows EPERM failure mode this launcher used to
  // be able to hit).
  console.log('[PREBUILD] Checking workspace packages are up to date...\n');
  const prebuild = spawnSync('node', ['scripts/ensure-fresh-packages.mjs'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (prebuild.status !== 0) {
    console.error('\n[STARTUP FAILED] A workspace package failed to build. Fix the error above and re-run.');
    process.exit(1);
  }
  console.log('');

  killExistingProcesses();

  // Give 1 second for ports to clear
  await new Promise((r) => setTimeout(r, 1000));

  // Start all server services
  for (const svc of SERVICES) {
    startService(svc);
  }

  console.log('\n[WAITING] Verifying each service is actually listening and healthy...\n');

  const readiness = await Promise.all(
    SERVICES.map(async (svc) => {
      const result = await waitUntilReady(svc);
      if (result.ready) {
        console.log(`[READY] ${svc.name} — listening on ${svc.port}${svc.healthPath ? ` (${svc.healthPath} OK)` : ''}`);
      } else {
        console.error(`[FAILED] ${svc.name} — ${result.reason}`);
      }
      return { svc, ...result };
    }),
  );

  const failedServices = readiness.filter((r) => !r.ready);

  // Only tunnel services that actually came up — a tunnel to a dead port is
  // just a second place to hide the same failure.
  console.log('\n[WAITING] Starting Cloudflare tunnels for public endpoints...\n');
  const tunnelServices = SERVICES.filter((s) => s.tunnel && serviceState.get(s.id)?.ready);
  await Promise.all(tunnelServices.map((svc) => startCloudflareTunnel(svc)));

  // Save tunnels mapping
  writeFileSync(join(LOGS_DIR, 'tunnels.json'), JSON.stringify(tunnelUrls, null, 2));

  console.log('\n====================================================');
  console.log('           TRADEW SERVER & TUNNEL STATUS            ');
  console.log('====================================================');
  for (const svc of SERVICES) {
    const state = serviceState.get(svc.id);
    if (state?.ready) {
      const tunnel = tunnelUrls[svc.id] || '(Internal Service)';
      console.log(`* ${svc.name} — READY`);
      console.log(`  Local:     http://localhost:${svc.port}`);
      console.log(`  Tunnel:    ${tunnel}`);
    } else {
      console.log(`* ${svc.name} — FAILED`);
    }
    console.log('----------------------------------------------------');
  }

  if (failedServices.length > 0) {
    console.error(`\n[STARTUP FAILED] ${failedServices.length} service(s) did not come up cleanly:\n`);
    for (const { svc, reason } of failedServices) {
      const logPath = join(LOGS_DIR, `${svc.id}.log`);
      console.error(`--- ${svc.name} (${reason}) — last lines of ${logPath} ---`);
      for (const line of tailLog(logPath)) console.error(`  ${line}`);
      console.error('');
    }
    console.error(`All logs saved to: ${LOGS_DIR}`);
    console.error('Stopping any services that did start...');
    killExistingProcesses();
    // Explicit exit, not exitCode: healthy sibling services keep long-running
    // child handles open (shell:true spawns), which would otherwise hold the
    // event loop and hang `npm run start:all` instead of returning non-zero.
    process.exit(1);
  }

  console.log(`All logs saved to: ${LOGS_DIR}`);
  console.log('Press Ctrl+C to stop all servers and tunnels.');
  console.log('====================================================\n');
}

process.on('SIGINT', () => {
  console.log('\nStopping all processes and tunnels...');
  killExistingProcesses();
  process.exit(0);
});

process.on('SIGTERM', () => {
  killExistingProcesses();
  process.exit(0);
});

main();
