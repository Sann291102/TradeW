/* eslint-disable no-console */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

/**
 * Dhan feed supervisor — the "non-stop, hands-off" runtime for real market data.
 *
 * WHAT PROBLEM THIS SOLVES
 * The live-feed bridge (live-feed-server.ts) is real but ephemeral: it holds
 * candles in memory, exits if it crashes, and depends on a Dhan access token
 * that Dhan/SEBI cap at 24 hours. Left alone it eventually goes quiet and the
 * whole platform silently falls back to "no market data". This supervisor keeps
 * real data flowing with as little human touch as the rules allow:
 *
 *   1. AUTO-START + AUTO-RECONNECT. Spawns the bridge and restarts it on exit
 *      with exponential backoff, so a transient Dhan disconnect or crash self-
 *      heals instead of ending the session.
 *   2. DURABLE PERSISTENCE. Periodically runs the idempotent candle backfill so
 *      the real session is written to Postgres (Candle table), not just held in
 *      the bridge's memory. Data then survives restarts and token lapses, and
 *      Sentinel's /observe reads real history even between ticks.
 *   3. TOKEN LIFECYCLE. Decodes the current access token, logs its remaining
 *      life, and — when it is expired or within the renewal window — uses the
 *      PERMANENT app_id/app_secret (12-month) to generate a fresh Dhan consent
 *      and prints the one-click login URL. This is the closest to "forever"
 *      that Dhan permits: the token itself is capped at 24h and its final mint
 *      requires an interactive Dhan 2FA login by design (SEBI API-access rule),
 *      so this automates everything around that single step rather than
 *      pretending it can be removed.
 *
 * Run:  npm run dhan:supervise -w @tradew/market-data-service
 * Env:  DHAN_ACCESS_TOKEN, DHAN_CLIENT_ID, DHAN_APP_ID/DHAN_API_KEY,
 *       DHAN_APP_SECRET/DHAN_API_SECRET  (all already in the root .env)
 * Tunables (optional):
 *       SUPERVISOR_SYMBOLS         default NIFTY,BANKNIFTY,FINNIFTY
 *       SUPERVISOR_TIMEFRAMES      default 1m,5m,15m
 *       SUPERVISOR_PERSIST_MIN     default 5  (persistence cadence, minutes)
 *       DHAN_TOKEN_RENEW_MIN       default 60 (start nudging renewal this early)
 */

const DHAN_AUTH = process.env.DHAN_AUTH_URL || 'https://auth.dhan.co';

const ENV_CANDIDATES = ['services/market-data/.env', 'services/api/.env', 'services/sentinel/.env', '.env'];

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'services')) && existsSync(resolve(dir, 'packages'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, '../../..');
}
const ROOT = repoRoot();
const MARKET_DATA_DIR = resolve(ROOT, 'services/market-data');

function loadEnvMerged(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const rel of ENV_CANDIDATES) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    const parsed = loadEnv({ path, processEnv: {} as NodeJS.ProcessEnv }).parsed ?? {};
    for (const [k, v] of Object.entries(parsed)) if (!(k in merged)) merged[k] = v;
  }
  // real process env wins (e.g. a token just written by a refresh)
  for (const [k, v] of Object.entries(process.env)) if (v != null) merged[k] = v;
  return merged;
}

interface TokenState {
  present: boolean;
  valid: boolean;
  expiresAt: Date | null;
  hoursLeft: number | null;
}

function inspectToken(token: string | undefined): TokenState {
  if (!token) return { present: false, valid: false, expiresAt: null, hoursLeft: null };
  const parts = token.split('.');
  if (parts.length !== 3) return { present: true, valid: false, expiresAt: null, hoursLeft: null };
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!claims.exp) return { present: true, valid: false, expiresAt: null, hoursLeft: null };
    const expiresAt = new Date(claims.exp * 1000);
    const hoursLeft = (claims.exp - Date.now() / 1000) / 3600;
    return { present: true, valid: hoursLeft > 0, expiresAt, hoursLeft };
  } catch {
    return { present: true, valid: false, expiresAt: null, hoursLeft: null };
  }
}

/** Ask Dhan for a fresh consent and print the one-click renewal URL. */
async function printRenewalUrl(env: Record<string, string>): Promise<void> {
  const appId = env.DHAN_APP_ID || env.DHAN_API_KEY;
  const appSecret = env.DHAN_APP_SECRET || env.DHAN_API_SECRET;
  const clientId = env.DHAN_CLIENT_ID;
  if (!appId || !appSecret || !clientId) {
    console.warn('[token] cannot generate consent — app_id/app_secret/client_id missing');
    return;
  }
  try {
    const res = await fetch(`${DHAN_AUTH}/app/generate-consent?client_id=${encodeURIComponent(clientId)}`, {
      method: 'POST',
      headers: { app_id: appId, app_secret: appSecret, 'Content-Type': 'application/json' },
    });
    const body = (await res.json()) as { consentAppId?: string };
    if (!body.consentAppId) {
      console.warn(`[token] Dhan did not return a consentAppId: ${JSON.stringify(body)}`);
      return;
    }
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log(' DHAN TOKEN RENEWAL NEEDED — one interactive login (SEBI 2FA rule)');
    console.log(' 1. Open and log in to Dhan:');
    console.log(`      ${DHAN_AUTH}/login/consentApp-login?consentAppId=${body.consentAppId}`);
    console.log(' 2. Paste the ?tokenId=… redirect URL into:');
    console.log('      npm run dhan:token -- "<redirect-url>" -w @tradew/market-data-service');
    console.log(' The supervisor keeps serving persisted real candles until then.');
    console.log('════════════════════════════════════════════════════════════════\n');
  } catch (err) {
    console.warn(`[token] consent generation failed: ${err instanceof Error ? err.message : err}`);
  }
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Node 20+ refuses to spawn a .cmd shim without shell:true (CVE-2024-27980),
// so on Windows the child must run through the shell.
const useShell = process.platform === 'win32';

/** Spawn the live-feed bridge; resolves when the child exits (with its code). */
function runBridge(): { child: ChildProcess; done: Promise<number> } {
  const child = spawn(npmCmd, ['run', 'live:server'], {
    cwd: MARKET_DATA_DIR,
    stdio: 'inherit',
    env: process.env,
    shell: useShell,
  });
  const done = new Promise<number>((resolveDone) => {
    child.on('exit', (code) => resolveDone(code ?? 0));
    child.on('error', (err) => {
      console.error(`[bridge] spawn error: ${err instanceof Error ? err.message : err}`);
      resolveDone(1);
    });
  });
  return { child, done };
}

/** Run one idempotent persistence pass (backfill → Postgres). Non-fatal on failure. */
function runPersist(symbols: string, timeframes: string): Promise<void> {
  return new Promise((resolveDone) => {
    const child = spawn(
      npmCmd,
      ['run', 'backfill:candles', '--', '--symbols', symbols, '--timeframes', timeframes, '--days', '2'],
      { cwd: MARKET_DATA_DIR, stdio: 'inherit', env: process.env, shell: useShell },
    );
    child.on('exit', () => resolveDone());
    child.on('error', (err) => {
      console.warn(`[persist] backfill spawn error: ${err instanceof Error ? err.message : err}`);
      resolveDone();
    });
  });
}

/** IST hour, for market-hours-aware persistence cadence. */
function istHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
}

async function main() {
  const env = loadEnvMerged();
  const symbols = env.SUPERVISOR_SYMBOLS || 'NIFTY,BANKNIFTY,FINNIFTY';
  const timeframes = env.SUPERVISOR_TIMEFRAMES || '1m,5m,15m';
  const persistMin = Number(env.SUPERVISOR_PERSIST_MIN || '5');
  const renewMin = Number(env.DHAN_TOKEN_RENEW_MIN || '60');

  console.log('[supervisor] Dhan feed supervisor starting');
  console.log(`[supervisor] persistence: ${symbols} @ ${timeframes} every ${persistMin}m`);

  const tok = inspectToken(env.DHAN_ACCESS_TOKEN);
  if (!tok.present) {
    console.warn('[token] no DHAN_ACCESS_TOKEN set.');
    await printRenewalUrl(env);
  } else if (!tok.valid) {
    console.warn('[token] current token is EXPIRED.');
    await printRenewalUrl(env);
  } else {
    console.log(`[token] valid for ${tok.hoursLeft!.toFixed(1)}h (until ${tok.expiresAt!.toISOString()})`);
    if (tok.hoursLeft! * 60 <= renewMin) await printRenewalUrl(env);
  }

  // --- token watch: re-check periodically, nudge renewal inside the window ---
  let renewalNudged = false;
  setInterval(
    () => {
      void (async () => {
        const t = inspectToken(loadEnvMerged().DHAN_ACCESS_TOKEN);
        if (t.valid && t.hoursLeft != null) {
          console.log(`[token] ${t.hoursLeft.toFixed(1)}h left`);
          if (t.hoursLeft * 60 <= renewMin && !renewalNudged) {
            renewalNudged = true;
            await printRenewalUrl(loadEnvMerged());
          }
          if (t.hoursLeft * 60 > renewMin) renewalNudged = false; // reset after a fresh token lands
        } else if (!renewalNudged) {
          renewalNudged = true;
          await printRenewalUrl(loadEnvMerged());
        }
      })();
    },
    10 * 60_000,
  );

  // --- durable persistence loop -------------------------------------------
  const persistTick = async () => {
    const h = istHour();
    // Persist frequently during/around the NSE session; a slow heartbeat otherwise.
    const active = h >= 9 && h <= 16;
    if (active) await runPersist(symbols, timeframes);
  };
  // One pass immediately so Postgres holds the latest real session on boot
  // regardless of the hour (pre-market included); the recurring cadence then
  // gates on market hours to avoid spending the Dhan request budget overnight.
  void runPersist(symbols, timeframes);
  setInterval(() => void persistTick(), Math.max(1, persistMin) * 60_000);

  // --- bridge supervision with backoff ------------------------------------
  let backoff = 1000;
  const MAX_BACKOFF = 30_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log('[bridge] starting live feed');
    const { done } = runBridge();
    const code = await done;
    console.warn(`[bridge] exited with code ${code} — restarting in ${(backoff / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(MAX_BACKOFF, backoff * 2);
    // A bridge that stayed up a while resets the backoff on its next healthy run.
    setTimeout(() => (backoff = 1000), 60_000);
  }
}

main().catch((err) => {
  console.error('[supervisor] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
