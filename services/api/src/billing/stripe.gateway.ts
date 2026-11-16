import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe = require('stripe');

export type StripeMode = 'test' | 'live';

export interface StripeConfig {
  mode: StripeMode;
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
  /** Configuration problems that disable billing. Never contains key material. */
  problems: string[];
}

/**
 * Read Stripe configuration from the environment.
 *
 * TEST → LIVE IS ENV-ONLY. `STRIPE_MODE` says which mode the deployment
 * intends, and every key must carry the matching prefix (`sk_test_`/`rk_test_`
 * and `pk_test_` in test; `sk_live_`/`rk_live_` and `pk_live_` in live). A
 * mismatch (a live key on a server that says it is in test, or the reverse)
 * disables billing rather than guessing which one was meant. Nothing in code
 * changes between modes.
 */
export function resolveStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const mode: StripeMode = (env.STRIPE_MODE || 'test').trim().toLowerCase() === 'live' ? 'live' : 'test';
  const requestedMode = (env.STRIPE_MODE || 'test').trim().toLowerCase();
  const secretKey = env.STRIPE_SECRET_KEY?.trim() || undefined;
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY?.trim() || undefined;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
  const problems: string[] = [];

  if (requestedMode !== 'test' && requestedMode !== 'live') problems.push(`STRIPE_MODE must be "test" or "live"`);
  if (!secretKey) problems.push('STRIPE_SECRET_KEY is not set');
  else if (!secretKey.startsWith(`sk_${mode}_`) && !secretKey.startsWith(`rk_${mode}_`)) {
    problems.push(`STRIPE_SECRET_KEY is not a ${mode}-mode key (STRIPE_MODE=${mode})`);
  }
  if (!publishableKey) problems.push('STRIPE_PUBLISHABLE_KEY is not set');
  else if (!publishableKey.startsWith(`pk_${mode}_`)) {
    problems.push(`STRIPE_PUBLISHABLE_KEY is not a ${mode}-mode key (STRIPE_MODE=${mode})`);
  }
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) problems.push('STRIPE_WEBHOOK_SECRET must start with whsec_');

  return { mode, secretKey, publishableKey, webhookSecret, problems };
}

/**
 * The one place the Stripe SDK is constructed. Server-side only: the secret
 * key never leaves this process, and the browser only ever receives the
 * publishable key and per-intent client secrets.
 */
@Injectable()
export class StripeGateway {
  private readonly logger = new Logger(StripeGateway.name);
  readonly config: StripeConfig;
  private readonly client: Stripe.Stripe | null;

  constructor() {
    this.config = resolveStripeConfig();
    if (this.config.problems.length) {
      this.logger.warn(`Stripe billing disabled: ${this.config.problems.join('; ')}`);
      this.client = null;
      return;
    }
    this.client = new Stripe(this.config.secretKey!, {
      // Stripe retries idempotent-safe failures (network, 409 lock, 5xx) with
      // the same idempotency key, so a retry can never double-charge.
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'TradeW' },
    });
    this.logger.log(`Stripe ready in ${this.config.mode.toUpperCase()} mode`);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  get mode(): StripeMode {
    return this.config.mode;
  }

  get publishableKey(): string | null {
    return this.enabled ? this.config.publishableKey! : null;
  }

  get webhookSecret(): string | undefined {
    return this.config.webhookSecret;
  }

  /** The SDK client. Throws 503 when billing is not configured. */
  get stripe(): Stripe.Stripe {
    if (!this.client) throw new ServiceUnavailableException('Payments are not enabled on this server.');
    return this.client;
  }
}
