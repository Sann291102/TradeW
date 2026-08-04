/* eslint-disable no-console */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

/**
 * Dhan access-token refresh, from the command line.
 *
 * Dhan's data token is valid for a single trading day. The consent flow that
 * mints one already exists in `services/api/src/broker/dhan-auth.service.ts`,
 * but it is a *browser* flow: it needs a signed-in TradeW user and a redirect
 * URL registered with Dhan. That is the right shape for a trader connecting
 * their own account in production, and the wrong shape for getting a laptop
 * back onto real data at 9am — which is why the token in `.env` goes stale and
 * every downstream engine silently falls back to "no market data".
 *
 * This tool drives the same three-step flow without a browser session:
 *
 *   npm run dhan:status                     what the current token says
 *   npm run dhan:consent                    -> prints the URL to open
 *   npm run dhan:token -- <tokenId|url>     -> exchanges and writes .env
 *
 * Step two happens in the user's own browser, at Dhan, under their own
 * credentials. Nothing here ever handles a Dhan password.
 *
 * The exchanged token is written to every .env that the feed registry reads
 * (`packages/market-data/src/registry.ts` sources `DHAN_ACCESS_TOKEN` from the
 * environment), so the bridge picks it up on its next restart.
 */

const DHAN_AUTH = 'https://auth.dhan.co';

/** Env files that may hold Dhan credentials, most specific first. */
const ENV_CANDIDATES = [
  'services/market-data/.env',
  'services/api/.env',
  'services/sentinel/.env',
  '.env',
];

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

/** Load every candidate env file without letting a later one clobber an earlier. */
function loadCredentials(): { appId: string; appSecret: string; clientId: string } {
  const merged: Record<string, string> = {};
  for (const rel of ENV_CANDIDATES) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    const parsed = loadEnv({ path, processEnv: {} as NodeJS.ProcessEnv }).parsed ?? {};
    for (const [k, v] of Object.entries(parsed)) if (!(k in merged)) merged[k] = v;
  }

  // `DHAN_APP_ID`/`DHAN_APP_SECRET` are the documented names; the API service
  // also accepts `DHAN_API_KEY`/`DHAN_API_SECRET` for the same pair, so both
  // spellings are honoured rather than silently ignoring one.
  const appId = merged.DHAN_APP_ID || merged.DHAN_API_KEY || '';
  const appSecret = merged.DHAN_APP_SECRET || merged.DHAN_API_SECRET || '';
  const clientId = merged.DHAN_CLIENT_ID || '';

  return { appId, appSecret, clientId };
}

/** Decode a JWT's payload. Never prints the token itself. */
function describeToken(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) return `opaque token, ${token.length} chars`;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    const expIso = new Date(claims.exp * 1000).toISOString();
    const delta = claims.exp - now;
    const state =
      delta > 0 ? `VALID for ${(delta / 3600).toFixed(1)}h` : `EXPIRED ${(-delta / 3600).toFixed(1)}h ago`;
    return `${state} (exp ${expIso}, client ${claims.dhanClientId ?? '?'})`;
  } catch {
    return 'unparseable JWT payload';
  }
}

async function dhanPost<T>(path: string, appId: string, appSecret: string): Promise<T> {
  const res = await fetch(`${DHAN_AUTH}${path}`, {
    method: 'POST',
    headers: { app_id: appId, app_secret: appSecret, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dhan responded ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Dhan returned non-JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Write `DHAN_ACCESS_TOKEN` into an env file, replacing any existing entry.
 *
 * Rewrites the matching line in place rather than appending, so repeated
 * refreshes do not grow the file with a stack of dead tokens — with dotenv's
 * last-wins parsing that would still work, but it makes the file unreadable
 * and the real value impossible to find by eye.
 */
function writeToken(relPath: string, token: string): boolean {
  const path = resolve(ROOT, relPath);
  if (!existsSync(path)) return false;

  const original = readFileSync(path, 'utf8');
  const line = `DHAN_ACCESS_TOKEN=${token}`;
  const pattern = /^DHAN_ACCESS_TOKEN=.*$/m;
  const updated = pattern.test(original)
    ? original.replace(pattern, line)
    : `${original.replace(/\s*$/, '')}\n${line}\n`;

  if (updated === original) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const { appId, appSecret, clientId } = loadCredentials();

  if (command === 'status') {
    let found = false;
    for (const rel of ENV_CANDIDATES) {
      const path = resolve(ROOT, rel);
      if (!existsSync(path)) continue;
      const parsed = loadEnv({ path, processEnv: {} as NodeJS.ProcessEnv }).parsed ?? {};
      if (!parsed.DHAN_ACCESS_TOKEN) continue;
      found = true;
      console.log(`${rel.padEnd(32)} ${describeToken(parsed.DHAN_ACCESS_TOKEN)}`);
    }
    if (!found) console.log('No DHAN_ACCESS_TOKEN found in any env file.');
    console.log(
      `\ncredentials: app_id ${appId ? 'set' : 'MISSING'}, app_secret ${appSecret ? 'set' : 'MISSING'}, client_id ${clientId || 'MISSING'}`,
    );
    return;
  }

  if (!appId || !appSecret) {
    console.error(
      'DHAN_APP_ID/DHAN_APP_SECRET (or DHAN_API_KEY/DHAN_API_SECRET) must be set in one of:\n  ' +
        ENV_CANDIDATES.join('\n  '),
    );
    process.exit(1);
  }

  if (command === 'consent') {
    if (!clientId) {
      console.error('DHAN_CLIENT_ID is required to generate a consent.');
      process.exit(1);
    }
    const body = await dhanPost<{ consentAppId?: string; consentAppStatus?: string }>(
      `/app/generate-consent?client_id=${encodeURIComponent(clientId)}`,
      appId,
      appSecret,
    );
    if (!body.consentAppId) {
      console.error(`Dhan did not return a consentAppId: ${JSON.stringify(body)}`);
      process.exit(1);
    }

    console.log(`consent ${body.consentAppId} (${body.consentAppStatus ?? 'unknown'})\n`);
    console.log('1. Open this URL and log in to Dhan:\n');
    console.log(`   ${DHAN_AUTH}/login/consentApp-login?consentAppId=${body.consentAppId}\n`);
    console.log('2. After login you are redirected to a URL containing ?tokenId=…');
    console.log('3. Run, pasting either the tokenId or the whole redirect URL:\n');
    console.log('   npm run dhan:token -- "<tokenId-or-redirect-url>"');
    return;
  }

  if (command === 'set') {
    // The direct path, and in practice the common one: Dhan's dashboard issues
    // a 24-hour access token on demand. That needs no consent id and no public
    // redirect URL, so it works when the tunnel that would receive the
    // redirect is not running — which is exactly when you most need it.
    const token = (argument ?? '').trim();
    if (!token) {
      console.error('Usage: npm run dhan:set -- "<access-token>"');
      process.exit(1);
    }
    if (token.split('.').length !== 3) {
      console.error('That does not look like a Dhan access token (expected a three-part JWT).');
      process.exit(1);
    }

    const summary = describeToken(token);
    if (summary.startsWith('EXPIRED')) {
      console.error(`Refusing to install an already-expired token — ${summary}`);
      process.exit(1);
    }

    console.log(`installing token — ${summary}\n`);
    let wrote = 0;
    for (const rel of ENV_CANDIDATES) {
      const written = writeToken(rel, token);
      if (written) wrote++;
      console.log(`  ${written ? 'updated' : 'skipped'}  ${rel}`);
    }
    if (wrote === 0) {
      console.error('\nNo env file was updated — none of the candidate paths exist.');
      process.exit(1);
    }
    console.log('\nRestart the live feed so it picks the token up:');
    console.log('  npm run live:server -w @tradew/market-data-service');
    return;
  }

  if (command === 'exchange') {
    if (!argument) {
      console.error('Usage: npm run dhan:token -- "<tokenId-or-redirect-url>"');
      process.exit(1);
    }
    // Accept the whole redirect URL as well as a bare id — copying the address
    // bar is what a user will actually do, and asking them to surgically
    // extract a query parameter is a needless step that invites mistakes.
    let tokenId = argument.trim();
    if (tokenId.includes('tokenId=')) {
      tokenId = decodeURIComponent(tokenId.split('tokenId=')[1].split('&')[0]);
    }

    const body = await dhanPost<{ accessToken?: string; dhanClientId?: string }>(
      `/app/consumeApp-consent?tokenId=${encodeURIComponent(tokenId)}`,
      appId,
      appSecret,
    );
    if (!body.accessToken) {
      console.error(`Dhan did not return an accessToken: ${JSON.stringify(body)}`);
      process.exit(1);
    }

    console.log(`token acquired — ${describeToken(body.accessToken)}\n`);
    for (const rel of ENV_CANDIDATES) {
      const written = writeToken(rel, body.accessToken);
      console.log(`  ${written ? 'updated' : 'skipped'}  ${rel}`);
    }
    console.log('\nRestart the live feed so it picks the token up:');
    console.log('  npm run live:server -w @tradew/market-data-service');
    return;
  }

  console.log('Usage:');
  console.log('  npm run dhan:status                    inspect the current token');
  console.log('  npm run dhan:consent                   start the login flow');
  console.log('  npm run dhan:token -- "<tokenId|url>"  exchange and write .env');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
