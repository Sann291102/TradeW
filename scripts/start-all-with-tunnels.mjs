import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as http from 'node:http';

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
    tunnel: false,
  },
  {
    name: 'API Backend',
    id: 'api',
    cmd: 'npm',
    args: ['run', 'dev:api'],
    port: 4000,
    tunnel: false,
  },
  {
    name: 'Sentinel AI Service',
    id: 'sentinel',
    cmd: 'npm',
    args: ['run', 'dev:sentinel'],
    port: 4010,
    tunnel: false,
  },
  {
    name: 'Sentinel Python',
    id: 'sentinel-py',
    cmd: 'npm',
    args: ['run', 'dev:sentinel-py'],
    port: 4011,
    tunnel: false,
  },
  {
    name: 'TradeW AI Assistant',
    id: 'tradew-ai',
    cmd: 'npm',
    args: ['run', 'dev:ai'],
    port: 4020,
    tunnel: false,
  },
  {
    name: 'Web Frontend',
    id: 'web',
    cmd: 'npm',
    args: ['run', 'dev:web'],
    port: 3000,
    tunnel: true,
  },
  {
    name: 'Admin Portal',
    id: 'admin',
    cmd: 'npm',
    args: ['run', 'dev:admin'],
    port: 3001,
    tunnel: true,
  },
];

const processes = [];
const tunnelUrls = {};

function startService(svc) {
  const logPath = join(LOGS_DIR, `${svc.id}.log`);
  const logStream = createWriteStream(logPath, { flags: 'w' });
  console.log(`[STARTING] ${svc.name} on port ${svc.port}...`);

  const proc = spawn(svc.cmd, svc.args, {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on('error', (err) => {
    console.error(`[ERROR] ${svc.name}: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.log(`[WARN] ${svc.name} exited with code: ${code}`);
    }
  });

  processes.push({ name: svc.name, proc });
  return proc;
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

  killExistingProcesses();

  // Give 1 second for ports to clear
  await new Promise((r) => setTimeout(r, 1000));

  // Start all server services
  for (const svc of SERVICES) {
    startService(svc);
  }

  console.log('\n[WAITING] Starting Cloudflare tunnels for public endpoints...\n');

  // Start tunnels for tunnel-enabled services
  const tunnelServices = SERVICES.filter((s) => s.tunnel);
  await Promise.all(tunnelServices.map((svc) => startCloudflareTunnel(svc)));

  // Save tunnels mapping
  writeFileSync(join(LOGS_DIR, 'tunnels.json'), JSON.stringify(tunnelUrls, null, 2));

  console.log('\n====================================================');
  console.log('           TRADEW ACTIVE SERVERS & TUNNELS          ');
  console.log('====================================================');
  for (const svc of SERVICES) {
    const tunnel = tunnelUrls[svc.id] || '(Internal Service)';
    console.log(`* ${svc.name}`);
    console.log(`  Local:     http://localhost:${svc.port}`);
    console.log(`  Tunnel:    ${tunnel}`);
    console.log('----------------------------------------------------');
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
