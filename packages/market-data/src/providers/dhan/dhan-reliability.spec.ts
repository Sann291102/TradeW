import { describe, expect, it, vi } from 'vitest';
import { DhanUpstreamError, classifyDhanFault } from './dhan-fault';
import { DhanCredential, readEnvFile } from './dhan-credential';
import { UpstreamGuard } from './upstream-guard';

/**
 * Regression suite for the 2026-08-17 Sentinel outage.
 *
 * Every test here fails against the code as it was that morning. The outage was
 * ONE mechanism with three visible symptoms, and the three describe blocks below
 * are those three links in the causal chain:
 *
 *   1. A credential captured once at boot, guaranteed to die inside Dhan's 24h
 *      cap, with no path back to the renewed value on disk.
 *   2. Every Dhan fault — a refused token, a rate limit — classified as a fact
 *      about the market ("this instrument has no option chain").
 *   3. Faults neither coalesced nor remembered, so one dead credential produced
 *      one metered upstream call per request per user.
 *
 * See SENTINEL_ROOT_CAUSE_AND_PERMANENT_FIX.md for the measured evidence.
 */

describe('classifyDhanFault — a fault is not a fact about the market', () => {
  it('classifies the exact 401 body from the outage as auth, not no-market', () => {
    // Verbatim from the running bridge, 2026-08-17 11:45 UTC.
    const body = JSON.stringify({
      errorType: 'Invalid_Authentication',
      errorCode: 'DH-901',
      errorMessage: 'Client ID or user generated access token is invalid or expired.',
    });
    expect(classifyDhanFault(401, body)).toBe('auth');
  });

  it('classifies 429 as rate-limit, not no-market', () => {
    // THE bug. `if (status >= 400 && status < 500) return []` swallowed this, so
    // a rate limit meant "no option chain" — and Dhan's option-chain family
    // allows roughly one call every 3 seconds, so concurrent users hit it
    // constantly.
    expect(classifyDhanFault(429, 'Too many requests')).toBe('rate-limit');
  });

  it('still classifies Dhan’s genuine no-derivatives answer as no-market', () => {
    // The one case the old blanket 4xx branch was actually written for. It must
    // keep working, or every cash-only equity starts reporting a fault.
    expect(classifyDhanFault(400, '{"errorCode":"DH-813","errorMessage":"Invalid SecurityId"}')).toBe('no-market');
  });

  it('reads an auth code out of a 400 body rather than trusting the status', () => {
    // Dhan returns 400 for both "no options market" and "your token died"; only
    // the body separates them. Reading the status alone is the original mistake.
    expect(classifyDhanFault(400, '{"errorCode":"DH-808","errorMessage":"Data API not subscribed"}')).toBe('auth');
  });

  it('matches auth WORDING so an unknown DH- code cannot become no-market', () => {
    expect(classifyDhanFault(400, '{"errorCode":"DH-999","errorMessage":"access token invalid or expired"}')).toBe(
      'auth',
    );
  });

  it('treats 5xx and a dead socket as upstream, never as no-market', () => {
    expect(classifyDhanFault(503, 'upstream unavailable')).toBe('upstream');
    expect(classifyDhanFault(0, 'ECONNREFUSED')).toBe('upstream');
  });

  it('classifies a non-JSON error page by scanning it, not defaulting to no-market', () => {
    expect(classifyDhanFault(400, '<html><body>DH-901 token expired</body></html>')).toBe('auth');
  });

  it('marks only auth faults as needing an operator', () => {
    expect(new DhanUpstreamError('auth', 401, 'DH-901', '/charts/intraday').needsOperator).toBe(true);
    expect(new DhanUpstreamError('rate-limit', 429, '', '/optionchain').needsOperator).toBe(false);
  });
});

describe('DhanCredential — the 24h cap cannot strand a running process', () => {
  it('re-reads the source after a rejection, so a renewed token needs no restart', async () => {
    // This is the outage, reduced to five lines. `stored` is the file on disk;
    // the operator rewrites it mid-run.
    let stored = 'token-from-yesterday';
    const resolve = vi.fn(async () => ({ accessToken: stored, source: 'env' as const }));
    const credential = new DhanCredential({ resolve });

    expect(await credential.get()).toBe('token-from-yesterday');

    // Dhan refuses it — 18 hours in, past the SEBI cap.
    credential.invalidate('401 DH-901 token expired');
    expect(credential.healthy).toBe(false);

    // The operator renews it in .env. The OLD code had no path from here to
    // there: `DHAN_TOKEN` was a module-level `let` assigned once at boot, so this
    // process presented the dead token until someone restarted it.
    stored = 'token-renewed-today';
    expect(await credential.get()).toBe('token-renewed-today');
    expect(credential.healthy).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent re-resolutions into one', async () => {
    // When a credential dies, every in-flight request fails at once. Each
    // resolution opens a PrismaClient, so 50 concurrent re-resolutions would turn
    // a credential fault into connection-pool exhaustion.
    let calls = 0;
    const credential = new DhanCredential({
      resolve: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { accessToken: 'tok', source: 'env' as const };
      },
    });

    const results = await Promise.all(Array.from({ length: 50 }, () => credential.get()));
    expect(results.every((t) => t === 'tok')).toBe(true);
    expect(calls).toBe(1);
  });

  it('does not loop when the source still holds the refused token', async () => {
    // The termination condition for the recovery path. `invalidate()` clears the
    // retry floor so the next read CAN re-resolve — otherwise a renewed token
    // would not be picked up until the floor expired, which is the bug this whole
    // class exists to remove. But if the source still holds the refused value,
    // that must count as a failure and re-arm the floor, or every request
    // re-reads the database to be told the same thing.
    let now = 1_000_000;
    let stored = 'dead-token';
    let calls = 0;
    const credential = new DhanCredential({
      resolve: async () => {
        calls++;
        return { accessToken: stored, source: 'env' as const };
      },
      retryFloorMs: 15_000,
      now: () => now,
    });

    expect(await credential.get()).toBe('dead-token');
    credential.invalidate('401 DH-901');

    // Recovery is attempted immediately — exactly once.
    expect(await credential.get()).toBeNull();
    expect(calls).toBe(2);

    // 200 requests over the next 10s must not add a single resolution.
    for (let i = 0; i < 200; i++) {
      now += 50;
      expect(await credential.get()).toBeNull();
    }
    expect(calls).toBe(2);

    // Operator renews it; recovery lands on the first attempt past the floor.
    stored = 'renewed';
    now += 15_000;
    expect(await credential.get()).toBe('renewed');
    expect(credential.healthy).toBe(true);
  });

  it('holds a floor between attempts so a dead credential is not re-resolved per request', async () => {
    let now = 1_000_000;
    let calls = 0;
    const credential = new DhanCredential({
      resolve: async () => {
        calls++;
        return null; // nothing available anywhere
      },
      retryFloorMs: 15_000,
      now: () => now,
    });

    expect(await credential.get()).toBeNull();
    expect(calls).toBe(1);

    // 100 requests arrive over the next 5 seconds. Not one of them may re-resolve.
    for (let i = 0; i < 100; i++) {
      now += 50;
      expect(await credential.get()).toBeNull();
    }
    expect(calls).toBe(1);

    // Past the floor, exactly one more attempt.
    now += 15_000;
    expect(await credential.get()).toBeNull();
    expect(calls).toBe(2);
  });

  it('refuses to serve a token past its stated expiry', async () => {
    let now = 1_000_000;
    let issued = 0;
    const credential = new DhanCredential({
      resolve: async () => ({
        accessToken: `tok-${++issued}`,
        source: 'db' as const,
        expiresAt: new Date(now + 60_000),
      }),
      now: () => now,
    });

    expect(await credential.get()).toBe('tok-1');
    now += 30_000;
    expect(await credential.get()).toBe('tok-1'); // still valid, no churn
    now += 31_000; // past expiry
    expect(await credential.get()).toBe('tok-2');
  });

  it('refreshes proactively before anything rejects the held token', async () => {
    let now = 1_000_000;
    let issued = 0;
    const credential = new DhanCredential({
      resolve: async () => ({ accessToken: `tok-${++issued}`, source: 'env' as const }),
      refreshAfterMs: 5 * 60_000,
      now: () => now,
    });

    expect(await credential.get()).toBe('tok-1');
    now += 5 * 60_000;
    // Recovery without a failed request first: the common case is that the
    // operator renewed the token minutes ago and nothing has failed yet.
    expect(await credential.get()).toBe('tok-2');
  });

  it('keeps the working token when a proactive refresh finds nothing newer', async () => {
    let now = 1_000_000;
    let calls = 0;
    const credential = new DhanCredential({
      resolve: async () => {
        calls++;
        return calls === 1 ? { accessToken: 'tok', source: 'env' as const } : null;
      },
      refreshAfterMs: 1_000,
      now: () => now,
    });

    expect(await credential.get()).toBe('tok');
    now += 2_000;
    // A refresh that finds nothing must not throw away a credential that works.
    expect(await credential.get()).toBe('tok');
  });

  it('reports its state, so a dead credential is visible instead of inferred', async () => {
    const credential = new DhanCredential({
      resolve: async () => ({ accessToken: 'tok', source: 'db' as const, detail: 'db:consent' }),
    });
    await credential.get();
    expect(credential.state()).toMatchObject({ healthy: true, source: 'db', lastFault: null });

    credential.invalidate('401 DH-901');
    // The field whose absence sent the 2026-08-17 investigation into the wrong
    // service: /status looked healthy while every REST call was being refused.
    expect(credential.state()).toMatchObject({ healthy: false, lastFault: '401 DH-901' });
  });
});

describe('readEnvFile — a running process must see the file, not its boot snapshot', () => {
  it('parses the current contents from disk', () => {
    const file = ['# comment', '', 'DHAN_ACCESS_TOKEN=renewed-today', 'QUOTED="with spaces"', 'EMPTY='].join('\n');
    const parsed = readEnvFile('/fake/.env', () => file);
    // dotenv would not have overwritten an already-set process.env value, and a
    // running process never sees a later edit at all — which is why the renewed
    // token was invisible to the bridge for the whole session.
    expect(parsed.DHAN_ACCESS_TOKEN).toBe('renewed-today');
    expect(parsed.QUOTED).toBe('with spaces');
    expect(parsed.EMPTY).toBe('');
  });

  it('treats a missing file as empty, not as a fault', () => {
    expect(
      readEnvFile('/nope/.env', () => {
        throw new Error('ENOENT');
      }),
    ).toEqual({});
  });
});

describe('UpstreamGuard — one fault must not become N upstream calls', () => {
  const authFault = () => new DhanUpstreamError('auth', 401, 'DH-901', '/charts/intraday');

  it('collapses 50 concurrent identical reads onto ONE upstream call', async () => {
    // Measured against the real bridge before the fix: 50 concurrent identical
    // /candles requests produced 50 upstream Dhan calls, wall 621ms, and the
    // repeat straight afterwards produced a 51st.
    let calls = 0;
    const guard = new UpstreamGuard<number[]>({ ttlMs: 60_000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        guard.get('NIFTY:15m:5', async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 5));
          return [1, 2, 3];
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.length === 3)).toBe(true);
    expect(guard.stats().coalesced).toBe(49);
  });

  it('remembers a FAULT, so repeated failing reads do not each hit upstream', async () => {
    // The measured hole: 8 sequential identical FAILING /candles requests made 8
    // upstream calls, because the old cache was written only on the success path.
    let calls = 0;
    let now = 1_000_000;
    const guard = new UpstreamGuard<number[]>({ ttlMs: 60_000, now: () => now });
    const attempt = () =>
      guard.get('NIFTY:15m:5', async () => {
        calls++;
        throw authFault();
      });

    for (let i = 0; i < 8; i++) {
      now += 100;
      await expect(attempt()).rejects.toThrow(DhanUpstreamError);
    }
    expect(calls).toBe(1);
    expect(guard.stats().faultsServed).toBe(7);
  });

  it('re-throws the SAME typed fault from the negative cache', async () => {
    // Damping must not change what the caller sees, or error handling downstream
    // silently diverges between the request that discovered the fault and the
    // ones that were damped.
    const guard = new UpstreamGuard<number[]>({ ttlMs: 60_000 });
    const run = () => guard.get('k', async () => Promise.reject(authFault()));
    await expect(run()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    await expect(run()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('retries once the fault window has passed', async () => {
    let calls = 0;
    let now = 1_000_000;
    const guard = new UpstreamGuard<number[]>({ ttlMs: 60_000, now: () => now });
    const attempt = () =>
      guard.get('k', async () => {
        calls++;
        throw authFault();
      });

    await expect(attempt()).rejects.toThrow();
    now += 30_001; // FAULT_CACHE_MS.auth
    await expect(attempt()).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('makes ZERO upstream calls while the credential breaker is open', async () => {
    // An auth fault is per-process, not per-symbol. Damping it per key would
    // still admit one call per symbol per window — with 219 selectable symbols
    // that is 219 guaranteed-failing metered calls.
    let calls = 0;
    const guard = new UpstreamGuard<number[]>({ ttlMs: 60_000, isOpen: () => authFault() });
    for (const symbol of ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS']) {
      await expect(
        guard.get(`${symbol}:15m:5`, async () => {
          calls++;
          return [1];
        }),
      ).rejects.toThrow(DhanUpstreamError);
    }
    expect(calls).toBe(0);
    expect(guard.stats().breakerRejections).toBe(4);
  });

  it('caches a good value for its TTL and refreshes after it', async () => {
    let calls = 0;
    let now = 1_000_000;
    const guard = new UpstreamGuard<number>({ ttlMs: 60_000, now: () => now });
    const read = () => guard.get('k', async () => ++calls);

    expect(await read()).toBe(1);
    now += 59_000;
    expect(await read()).toBe(1);
    now += 2_000;
    expect(await read()).toBe(2);
  });

  it('does not let one key’s fault suppress another key', async () => {
    const guard = new UpstreamGuard<string>({ ttlMs: 60_000 });
    await expect(guard.get('bad', async () => Promise.reject(authFault()))).rejects.toThrow();
    await expect(guard.get('good', async () => 'ok')).resolves.toBe('ok');
  });

  it('clears remembered faults when the credential is renewed', async () => {
    // Faults recorded against a dead token say nothing about a new one, so
    // holding them would delay recovery for no reason.
    let calls = 0;
    const guard = new UpstreamGuard<string>({ ttlMs: 60_000 });
    await expect(
      guard.get('k', async () => {
        calls++;
        throw authFault();
      }),
    ).rejects.toThrow();

    guard.clearFaults();
    await expect(
      guard.get('k', async () => {
        calls++;
        return 'recovered';
      }),
    ).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('bounds retained keys so an unbounded symbol space cannot leak', async () => {
    const guard = new UpstreamGuard<number>({ ttlMs: 60_000, maxEntries: 10 });
    for (let i = 0; i < 100; i++) await guard.get(`sym-${i}`, async () => i);
    expect(guard.stats().keys).toBeLessThanOrEqual(10);
  });
});
