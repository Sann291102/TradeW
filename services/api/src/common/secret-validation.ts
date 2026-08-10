/**
 * Boot-time validation for the secrets that ARE authentication boundaries.
 *
 * The 2026-08-10 security assessment found the whole auth model resting on
 * values that were never secret:
 *
 *   · JWT_SECRET fell back to the literal 'dev-secret-change-me' baked into
 *     app.module.ts, and the committed .env used exactly that value. A string
 *     that appears in source can be used by anyone to forge a token for any
 *     user — proven end to end (forged an admin's token, read their portfolio,
 *     with no password).
 *   · ADMIN_API_TOKEN held a live Anthropic API key, the SAME value as
 *     ANTHROPIC_API_KEY. A paid third-party credential was doubling as the
 *     operator shared secret, so leaking either leaked both.
 *
 * A silent fallback turns a missing/weak secret into a running-but-open
 * deployment. Failing fast at boot turns it into a deploy-time error instead —
 * loud, early, and impossible to ship past. These helpers are the single place
 * that decision lives, so no individual call site can quietly reintroduce a
 * `|| 'dev-secret'` default.
 *
 * All of this reads process.env, which main.ts has already populated from the
 * root .env before AppModule is imported.
 */

/** Values that have appeared as insecure defaults in this repo's history and
 *  must never be accepted as a real secret. Lower-cased for comparison. */
const KNOWN_WEAK_SECRETS = new Set([
  'dev-secret-change-me',
  'dev-secret',
  'changeme',
  'change-me',
  'secret',
  'password',
  'dev-sentinel-token', // the shared service-token dev value
  'dev-sentinel-service-token',
]);

/** Prefixes that identify a value as a third-party vendor credential. An auth
 *  boundary must be a purpose-minted secret, never a reused vendor key: reusing
 *  one couples two blast radii and puts a paid key on the auth hot path. */
const VENDOR_KEY_PREFIXES = ['sk-ant-', 'sk-', 'nvapi-', 'tvly-', 'voyage-', 'pplx-', 'AIza', 'ghp_', 'xoxb-', 'xoxp-'];

export interface SecretPolicy {
  /** Minimum length in characters. Defaults to 32. */
  minLength?: number;
  /** Reject values that look like a third-party vendor key. Defaults to true. */
  rejectVendorKeys?: boolean;
  /** When true, an unset value returns undefined instead of throwing — for
   *  secrets whose own guard already fails closed on absence (the surface is
   *  simply disabled). Defaults to false: unset is a hard error. */
  optional?: boolean;
}

/**
 * Resolve and validate a required secret from the environment. Throws (aborting
 * boot) when the value is missing, a known weak default, too short, or a
 * reused vendor key.
 *
 * @param name  the environment variable name, used only in error messages.
 * @param value the raw environment value (pass process.env[name]).
 */
export function resolveSecret(name: string, value: string | undefined, policy: SecretPolicy = {}): string {
  const { minLength = 32, rejectVendorKeys = true, optional = false } = policy;
  const raw = (value ?? '').trim();

  if (!raw) {
    if (optional) return '';
    throw new Error(
      `[security] ${name} is not set. This value is an authentication boundary and has no safe default. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }

  if (KNOWN_WEAK_SECRETS.has(raw.toLowerCase())) {
    throw new Error(
      `[security] ${name} is set to a known development placeholder. Replace it with a unique random value ` +
        `before this process will start. Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }

  if (raw.length < minLength) {
    throw new Error(
      `[security] ${name} is only ${raw.length} characters; at least ${minLength} are required for an auth secret.`,
    );
  }

  if (rejectVendorKeys && VENDOR_KEY_PREFIXES.some((p) => raw.startsWith(p))) {
    throw new Error(
      `[security] ${name} looks like a third-party vendor API key (prefix "${raw.slice(0, 6)}…"). ` +
        `Do not reuse a vendor credential as an auth secret — mint a dedicated one. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    );
  }

  return raw;
}

/** True when the value is safe to use as an auth secret under the given policy.
 *  Pure predicate form of resolveSecret, for tests and non-throwing checks. */
export function isSecretAcceptable(value: string | undefined, policy: SecretPolicy = {}): boolean {
  try {
    resolveSecret('secret', value, policy);
    return true;
  } catch {
    return false;
  }
}
