import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { securityLog } from '../common/security-log';

/**
 * The TradeW Core side of the Admin Control Plane boundary.
 *
 * This guard protects `/control/*` — a NARROW administrative surface that is
 * deliberately separate from both the customer API and the existing `/admin/*`
 * operator routes. Nothing here is reachable by a browser, a customer JWT, or
 * the `ADMIN_API_TOKEN` shared secret.
 *
 * ── THE TRUST DIRECTION ────────────────────────────────────────────────────
 *
 * TradeW Core holds ONLY a public key. It can verify that the control plane
 * asked for something; it cannot itself produce a request that would verify.
 * That is intentional and is the whole point of the two-repository split: an
 * attacker who fully owns TradeW Core still cannot forge an administrative
 * action, cannot arm live trading, and cannot fabricate entries in the admin
 * plane's audit trail.
 *
 * The corollary is that this guard must never grow a "trusted internal caller"
 * bypass. If something inside TradeW needs to perform a control action, it must
 * ask the control plane, not skip the signature.
 *
 * ── WHAT IS CHECKED ────────────────────────────────────────────────────────
 *
 *  1. Protocol version matches.
 *  2. Key id maps to a configured public key (supports rotation: several may
 *     be configured at once, old ones removed after the new one is live).
 *  3. Timestamp is within MAX_CLOCK_SKEW_MS. Bounds the replay window and, with
 *     it, the size of the nonce cache.
 *  4. Nonce has not been seen. Defeats replay inside the skew window.
 *  5. Body hash matches the body actually received. Defeats body substitution
 *     against a captured signature.
 *  6. Ed25519 signature verifies over the canonical string.
 *  7. The claimed capability is one this control-plane identity may exercise
 *     AT ALL — an independent allowlist, not a mirror of the admin API's RBAC.
 */

const PROTOCOL = 'TRADEW-CONTROL-v1';
const MAX_CLOCK_SKEW_MS = 30_000;

/**
 * Capabilities TradeW Core will honour over the control channel, regardless of
 * what the admin plane believes its operator is entitled to.
 *
 * This is the second, independent authorization layer. It is intentionally
 * narrower than the admin plane's capability list: capabilities that are purely
 * internal to the control plane (managing admin users, reading the admin audit
 * log) have no meaning here and must be rejected rather than ignored.
 */
const CONTROL_PLANE_ALLOWED = new Set([
  'view_dashboard',
  'view_agents',
  'view_trading',
  'view_orders',
  'view_sentinel',
  'view_brain',
  'view_infrastructure',
  'control_agents',
  'paper_trade',
  'live_trade',
  'execute_orders',
  'modify_orders',
  'cancel_orders',
  'emergency_stop',
]);

interface SeenNonce {
  expiresAt: number;
}

@Injectable()
export class ControlGuard implements CanActivate {
  private readonly logger = new Logger(ControlGuard.name);
  private readonly keys = new Map<string, KeyObject>();
  private readonly seenNonces = new Map<string, SeenNonce>();
  private loaded = false;

  /**
   * Public keys come from CONTROL_PLANE_PUBLIC_KEYS as
   * `keyId:base64(spki-der)` pairs, comma separated. Multiple entries make
   * rotation a config change rather than a coordinated restart.
   */
  private loadKeys(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = process.env.CONTROL_PLANE_PUBLIC_KEYS ?? '';
    for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = entry.indexOf(':');
      if (idx < 1) continue;
      const keyId = entry.slice(0, idx);
      try {
        const key = createPublicKey({
          key: Buffer.from(entry.slice(idx + 1), 'base64'),
          format: 'der',
          type: 'spki',
        });
        if (key.asymmetricKeyType !== 'ed25519') {
          this.logger.error(`Control key ${keyId} is ${key.asymmetricKeyType}, expected ed25519 — ignored`);
          continue;
        }
        this.keys.set(keyId, key);
      } catch (err) {
        this.logger.error(`Control key ${keyId} failed to parse — ignored: ${String(err)}`);
      }
    }
    if (this.keys.size === 0) {
      // Fails closed: with no keys configured there is no control surface at
      // all, rather than an open one.
      this.logger.warn('No CONTROL_PLANE_PUBLIC_KEYS configured — /control/* is disabled');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    this.loadKeys();
    const req = context.switchToHttp().getRequest();
    const ip = req.ip ?? null;
    const h = (name: string): string => (typeof req.headers?.[name] === 'string' ? req.headers[name] : '');

    const deny = (event: string, detail: Record<string, unknown> = {}): never => {
      securityLog({
        event: `control.${event}`,
        outcome: 'denied',
        ip,
        userAgent: h('user-agent') || null,
        detail: { path: req.url, keyId: h('x-control-key-id'), ...detail },
      });
      throw new UnauthorizedException('Control request rejected');
    };

    if (this.keys.size === 0) deny('unconfigured');
    if (h('x-control-protocol') !== PROTOCOL) deny('protocol_mismatch', { got: h('x-control-protocol') });

    const key = this.keys.get(h('x-control-key-id'));
    if (!key) deny('unknown_key');

    const timestamp = Number(h('x-control-timestamp'));
    if (!Number.isFinite(timestamp)) deny('bad_timestamp');
    const skew = Math.abs(Date.now() - timestamp);
    if (skew > MAX_CLOCK_SKEW_MS) deny('stale_request', { skewMs: skew });

    const nonce = h('x-control-nonce');
    if (nonce.length < 16) deny('bad_nonce');
    this.sweepNonces();
    if (this.seenNonces.has(nonce)) deny('replayed_nonce');

    const actorId = h('x-control-actor');
    const capability = h('x-control-capability');
    if (!actorId || !capability) deny('missing_actor_or_capability');

    // `rawBody` is populated by the body-parser `verify` hook wired in main.ts.
    // Hashing the re-serialized parsed body instead would let a request whose
    // JSON round-trips differently (key order, duplicate keys, unicode escapes)
    // pass verification with different bytes than were signed.
    const rawBody: Buffer | undefined = req.rawBody;
    const bodyHash = createHash('sha256').update(rawBody ?? Buffer.alloc(0)).digest('hex');

    const canonical = [
      PROTOCOL,
      String(req.method).toUpperCase(),
      req.originalUrl ?? req.url,
      bodyHash,
      String(timestamp),
      nonce,
      actorId,
      capability,
    ].join('\n');

    let signatureValid = false;
    try {
      signatureValid = edVerify(
        null,
        Buffer.from(canonical, 'utf8'),
        key as KeyObject,
        Buffer.from(h('x-control-signature'), 'base64'),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) deny('bad_signature', { actorId });

    if (!CONTROL_PLANE_ALLOWED.has(capability)) {
      deny('capability_not_permitted', { actorId, capability });
    }

    // Recorded only after the signature verifies, so an attacker cannot fill
    // the cache with unsigned nonces.
    this.seenNonces.set(nonce, { expiresAt: Date.now() + MAX_CLOCK_SKEW_MS * 2 });

    req.control = {
      actorId,
      capability,
      keyId: h('x-control-key-id'),
      correlationId: h('x-correlation-id') || null,
    };

    securityLog({
      event: 'control.request',
      outcome: 'success',
      ip,
      userAgent: h('user-agent') || null,
      detail: { path: req.url, actorId, capability, correlationId: req.control.correlationId },
    });

    return true;
  }

  private sweepNonces(): void {
    const now = Date.now();
    for (const [nonce, meta] of this.seenNonces) {
      if (meta.expiresAt < now) this.seenNonces.delete(nonce);
    }
  }
}

/**
 * Declares the capability a control endpoint consumes. The guard checks the
 * signed claim against the allowlist; this asserts the endpoint's own
 * requirement so a mismatch is caught rather than assumed.
 */
export function requireControlCapability(expected: string) {
  return (req: { control?: { capability?: string } }): void => {
    if (req.control?.capability !== expected) {
      throw new ForbiddenException(`This endpoint requires capability ${expected}`);
    }
  };
}
