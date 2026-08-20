import { Logger } from '@nestjs/common';

/**
 * Structured security event logging.
 *
 * WHY A DEDICATED HELPER RATHER THAN `logger.log(...)` AT EACH SITE
 *
 * Security events need to be greppable and machine-parseable — an operator
 * asking "did anyone try to hijack a broker credential" should be able to filter
 * on one prefix, not read prose. Every event here emits a single line:
 *
 *   [security] {"event":"broker.oauth.state_rejected","outcome":"failure",...}
 *
 * More importantly, this is the one place that decides what may be logged. Every
 * field passes through `redact` below, so a caller cannot leak a token by
 * handing it to a log call — which is exactly how access tokens end up in log
 * aggregators. Callers pass identifiers and outcomes; secrets are dropped by the
 * helper, not by each caller remembering to.
 */

const logger = new Logger('security');

/** Field names whose values are never logged, matched case-insensitively as a
 *  substring. Deliberately broad: a false positive costs a redacted debug field,
 *  a false negative writes a live credential to disk. */
const FORBIDDEN_KEY_PATTERN =
  /token|secret|password|passwd|credential|authorization|cookie|session|apikey|api_key|accesstoken|refresh|state|nonce|signature|bearer/i;

/** Names that read like secrets but are safe identifiers, not secret material.
 *  `stateHash` stays redacted — a digest is still a lookup key for a live flow.
 *  Checked before FORBIDDEN_KEY_PATTERN. */
const ALLOWED_KEY_EXACT = new Set([
  'tokenIdPresent',
  'statePresent',
  'stateOutcome',
  'credentialSource',
  // Which key of the broker-credential keyring sealed or failed to open a row.
  // A short label like "k1" — matched by FORBIDDEN_KEY_PATTERN's `key`, but it
  // is a NAME, not material, and it is the one field that makes a decryption
  // failure diagnosable. The keys themselves live in an env var and are never
  // passed to this helper.
  'keyId',
]);

export type SecurityOutcome = 'success' | 'failure' | 'denied';

export interface SecurityEvent {
  /** Dotted, stable event name: `broker.oauth.state_rejected`. Filter on this. */
  event: string;
  outcome: SecurityOutcome;
  /** Acting user, when known. Never an email — an id is enough to investigate
   *  with and is not PII on its own. */
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Anything else useful. Values are redacted per the rules above. */
  detail?: Record<string, unknown>;
}

/**
 * Drop or mask anything that could be secret material.
 *
 * Two independent rules, because either alone is insufficient:
 *  · by KEY — a field called `accessToken` is dropped whatever it contains;
 *  · by SHAPE — a long opaque string is truncated even under an innocent key,
 *    which catches the case where a token is passed as `value` or `reason`.
 */
function redact(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!ALLOWED_KEY_EXACT.has(key) && FORBIDDEN_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 64) {
      // Long opaque strings are the shape of a credential. Keep enough to
      // correlate two log lines, never enough to replay.
      out[key] = `${value.slice(0, 8)}…[truncated ${value.length}]`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Emit one security event. `failure`/`denied` go to warn so they surface
 *  without turning on debug logging; `success` stays at log level. */
export function securityLog(event: SecurityEvent): void {
  const line = JSON.stringify({
    event: event.event,
    outcome: event.outcome,
    userId: event.userId ?? null,
    ip: event.ip ?? null,
    // Attacker-controlled and long; kept short so it cannot be used to flood or
    // to smuggle payloads into a log viewer.
    userAgent: event.userAgent ? event.userAgent.slice(0, 120) : null,
    ...(event.detail ? { detail: redact(event.detail) } : {}),
  });
  if (event.outcome === 'success') logger.log(line);
  else logger.warn(line);
}

/** Exported for the redaction test suite. Not part of the logging API. */
export const __testables = { redact };
