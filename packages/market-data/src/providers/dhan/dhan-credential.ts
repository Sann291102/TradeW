/**
 * The Dhan access token, as a thing with a LIFECYCLE rather than a value read
 * once at boot.
 *
 * ── THE INCIDENT THIS REMOVES ──────────────────────────────────────────────
 *
 * The live-feed bridge held its token in a module-level `let`, assigned once in
 * `main()` before anything else ran:
 *
 *     let DHAN_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';
 *     await resolveDhanToken();   // once, at boot, forever
 *
 * Dhan caps every access token at 24 hours — a SEBI rule on API access
 * management, not a Dhan policy choice, so it cannot be negotiated away. A
 * process that reads the token once and runs for longer than a day is therefore
 * GUARANTEED to reach a state where it holds a dead credential. Not likely:
 * guaranteed, by arithmetic.
 *
 * Measured on 2026-08-17: the bridge had 18.4h uptime, the operator had renewed
 * the token in `.env` 20 minutes earlier, `services/api` and `services/sentinel`
 * had both restarted and picked it up — and the bridge had not, so it was still
 * presenting yesterday's token to Dhan and being refused. Every Sentinel
 * observation failed with "no real market data available for NIFTY" while the
 * renewed, working token sat on disk.
 *
 * Two things made that unrecoverable without a restart, and this class fixes
 * both:
 *
 *  1. NOTHING RE-READ THE SOURCE. There was no path from "the token I hold is
 *     being refused" back to "read the token again". `invalidate()` is that
 *     path.
 *
 *  2. `process.env` IS A BOOT SNAPSHOT. dotenv does not overwrite variables
 *     that are already set, and a running process never sees a later edit to
 *     `.env` at all. So even a re-read of `process.env` would have returned the
 *     dead token. `readEnvFile` parses the file from DISK, which is where the
 *     renewed token actually lands.
 *
 * ── WHY A CLASS AND NOT A FUNCTION ────────────────────────────────────────
 *
 * Because the correctness conditions are all about concurrency, and none of them
 * can be expressed by a bare `async getToken()`:
 *
 *   · SINGLE-FLIGHT. When a credential dies, EVERY in-flight request fails at
 *     once. Without coalescing, 50 concurrent 401s trigger 50 concurrent
 *     re-resolutions, each opening its own PrismaClient — turning a credential
 *     fault into a connection-pool exhaustion. One re-resolution is shared.
 *
 *   · A FLOOR BETWEEN ATTEMPTS. A credential that is genuinely dead stays dead.
 *     Re-resolving on every request would hammer the database for a value that
 *     has not changed, so a failed re-resolution is not retried for
 *     `retryFloorMs`. Requests in that window fail fast, which is exactly what
 *     stops the retry storm.
 *
 *   · OBSERVABILITY. `state()` is what `/status` reports, so "the bridge is up
 *     but its credential is dead" is a state an operator can SEE instead of
 *     inferring from empty candle arrays.
 */

export type CredentialSource = 'db' | 'env' | 'none';

export interface DhanCredentialState {
  /** Whether a token is currently held and believed good. */
  healthy: boolean;
  source: CredentialSource;
  /** Set when the token was rejected; the verbatim upstream reason. */
  lastFault: string | null;
  /** When the held token was resolved. */
  resolvedAt: string | null;
  /** When it was last rejected by Dhan. */
  invalidatedAt: string | null;
  /** Stated expiry, when the source provides one. */
  expiresAt: string | null;
  /** How many times this process has resolved a token. A climbing number with
   *  no operator action means something is rejecting tokens in a loop. */
  resolutions: number;
  /** Non-null while a re-resolution is deliberately being withheld. */
  retryingInMs: number | null;
}

/** What a resolver hands back. `null` means "no credential available at all". */
export interface ResolvedCredential {
  accessToken: string;
  source: CredentialSource;
  /** Stated expiry when known. A resolver MUST NOT return an expired token. */
  expiresAt?: Date | null;
  /** Free-text provenance for the log line, e.g. `db:consent-flow`. */
  detail?: string;
}

export interface DhanCredentialOptions {
  /**
   * Where a token comes from. Called on first use, and again after
   * `invalidate()` — so it must READ ITS SOURCE, not close over a value.
   */
  resolve: () => Promise<ResolvedCredential | null>;
  /**
   * Re-resolve proactively once the held token is this old, before anything
   * rejects it. Belt to `invalidate()`'s braces: it turns the common case
   * (operator renewed the token an hour ago) into a silent recovery instead of
   * a recovery that costs one failed request first. Default 5 minutes.
   */
  refreshAfterMs?: number;
  /**
   * Minimum gap between resolution ATTEMPTS after a failure. A dead credential
   * must not be re-resolved per request. Default 15 seconds.
   */
  retryFloorMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class DhanCredential {
  private token: string | null = null;
  private source: CredentialSource = 'none';
  private expiresAt: Date | null = null;
  private resolvedAt = 0;
  private invalidatedAt = 0;
  private lastFault: string | null = null;
  /**
   * When a resolution attempt last failed to produce a USABLE token.
   *
   * Deliberately not "when a resolution was last attempted". Those differ, and
   * conflating them broke the recovery path: a SUCCESSFUL resolution also set
   * the timestamp, so the very next `invalidate()` fell inside the floor and
   * `get()` returned null instead of re-resolving — the credential stayed dead
   * for the floor duration even though a renewed token was already on disk. The
   * floor exists to stop a KNOWN-dead credential being re-resolved per request,
   * which is a statement about failures only.
   */
  private lastFailedAttemptAt = 0;
  /**
   * The exact token Dhan just refused.
   *
   * This is what makes "re-resolve after a rejection" terminate. Without it, a
   * dead credential loops: invalidate → re-resolve → get the same dead token
   * back from the same file → present it → refused → invalidate. Comparing
   * against the rejected value turns that into "nothing newer is available",
   * which is a failure, which holds the floor.
   */
  private rejectedToken: string | null = null;
  private resolutions = 0;
  /** The shared in-flight resolution. See SINGLE-FLIGHT above. */
  private inFlight: Promise<string | null> | null = null;

  private readonly refreshAfterMs: number;
  private readonly retryFloorMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: DhanCredentialOptions) {
    this.refreshAfterMs = options.refreshAfterMs ?? 5 * 60_000;
    this.retryFloorMs = options.retryFloorMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * The token to present to Dhan, or null when none can be had.
   *
   * Null is a first-class answer, not an exception: the caller must fail the
   * request WITHOUT calling Dhan, because a call with no credential is a
   * guaranteed 401 that spends rate-limit budget to learn what we already know.
   */
  async get(): Promise<string | null> {
    if (this.token && !this.isStale()) return this.token;
    // A failed resolution holds the floor. Serving the (known-bad) token here
    // would restart the storm, so this returns null and the caller fails fast.
    if (!this.token && this.withinRetryFloor()) return null;
    return this.resolveOnce();
  }

  /**
   * Report that Dhan refused the token we are holding.
   *
   * The next `get()` re-resolves, so a renewed token is picked up without a
   * restart. Idempotent under concurrency: 50 simultaneous 401s from one dead
   * credential record one invalidation, not fifty.
   */
  invalidate(reason: string): void {
    if (!this.token && this.lastFault === reason) return;
    this.rejectedToken = this.token;
    this.token = null;
    this.expiresAt = null;
    this.lastFault = reason;
    this.invalidatedAt = this.now();
    // Clear the floor: a rejection is NEW information, so the next read must be
    // allowed to re-resolve immediately. That attempt is the entire recovery
    // path — the whole point is that a renewed token is picked up without a
    // restart. It terminates because a re-resolution that returns the
    // already-rejected token counts as a failure and re-arms the floor.
    this.lastFailedAttemptAt = 0;
    this.log(`[dhan] credential rejected (${reason}) — will re-resolve from source on the next read`);
  }

  /** True when a token is held and nothing has rejected it. */
  get healthy(): boolean {
    return this.token !== null;
  }

  state(): DhanCredentialState {
    const floorLeft = this.withinRetryFloor() ? this.lastFailedAttemptAt + this.retryFloorMs - this.now() : null;
    return {
      healthy: this.healthy,
      source: this.source,
      lastFault: this.lastFault,
      resolvedAt: this.resolvedAt ? new Date(this.resolvedAt).toISOString() : null,
      invalidatedAt: this.invalidatedAt ? new Date(this.invalidatedAt).toISOString() : null,
      expiresAt: this.expiresAt ? this.expiresAt.toISOString() : null,
      resolutions: this.resolutions,
      retryingInMs: floorLeft !== null && floorLeft > 0 ? floorLeft : null,
    };
  }

  /** Held token is past its stated expiry, or past the proactive refresh age. */
  private isStale(): boolean {
    const now = this.now();
    if (this.expiresAt && this.expiresAt.getTime() <= now) return true;
    return now - this.resolvedAt >= this.refreshAfterMs;
  }

  private withinRetryFloor(): boolean {
    return this.lastFailedAttemptAt !== 0 && this.now() - this.lastFailedAttemptAt < this.retryFloorMs;
  }

  /** Coalesced resolution — concurrent callers share one attempt. */
  private resolveOnce(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;

    const attempt = (async (): Promise<string | null> => {
      try {
        const resolved = await this.options.resolve();
        if (!resolved?.accessToken) {
          // A stale token is worse than none: it is a guaranteed 401 that still
          // costs a round trip. Keep whatever we had ONLY if nothing has
          // rejected it — that is the "proactive refresh found nothing new"
          // case, where the held token is still the best available.
          if (this.token) {
            this.resolvedAt = this.now();
            this.log('[dhan] no newer credential available — keeping the current one');
            return this.token;
          }
          this.lastFault = 'no credential available (DB designation unset and DHAN_ACCESS_TOKEN empty)';
          this.lastFailedAttemptAt = this.now();
          this.log(`[dhan] ${this.lastFault}`);
          return null;
        }

        // The source still holds the token Dhan just refused, so the operator has
        // not renewed it yet. Treated as a failed attempt: serving it would be a
        // guaranteed 401, and re-resolving per request would hammer the database
        // for a value that has not changed.
        if (this.rejectedToken !== null && resolved.accessToken === this.rejectedToken) {
          this.lastFailedAttemptAt = this.now();
          this.log('[dhan] credential unchanged (awaiting token update in .env)');
          return null;
        }

        const changed = resolved.accessToken !== this.token;
        this.token = resolved.accessToken;
        this.source = resolved.source;
        this.expiresAt = resolved.expiresAt ?? null;
        this.resolvedAt = this.now();
        this.lastFailedAttemptAt = 0;
        this.rejectedToken = null;
        this.resolutions++;
        if (changed) {
          this.lastFault = null;
          this.log(
            `[dhan] credential resolved from ${resolved.detail ?? resolved.source}` +
              `${this.expiresAt ? `, expires ${this.expiresAt.toISOString()}` : ', no stated expiry'}`,
          );
        }
        return this.token;
      } catch (err) {
        this.lastFault = `resolution failed: ${err instanceof Error ? err.message : String(err)}`;
        this.lastFailedAttemptAt = this.now();
        this.log(`[dhan] ${this.lastFault}`);
        return this.token; // may be null; the caller fails fast either way
      } finally {
        this.inFlight = null;
      }
    })();

    this.inFlight = attempt;
    return attempt;
  }
}

/**
 * Parse `KEY=value` pairs straight from a `.env` file on disk.
 *
 * Deliberately NOT `dotenv`: dotenv's whole contract is to populate
 * `process.env` and to leave already-set variables alone, which is correct for
 * boot and useless here. This is a re-read of the file's CURRENT contents, which
 * is where an operator's renewed token actually is — see point 2 in the header.
 *
 * Returns an empty object when the file is absent, because a deployment that
 * configures the environment directly (containers, systemd) legitimately has no
 * `.env`, and that is not a fault.
 */
export function readEnvFile(path: string, readFileSync: (p: string, enc: 'utf8') => string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, as dotenv does.
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
