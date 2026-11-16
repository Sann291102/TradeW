import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';
import { StripeGateway } from './stripe.gateway';
import { describeStripeError } from './stripe-errors';
import { billingAudit } from './billing-audit';
import { LeaderElectionService } from '../common/leader-election';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 20;
const SWEEP_JOB = 'stripe-customer-retry-sweep';

type AddressRow = {
  kind: 'billing' | 'shipping';
  name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
};

function toStripeAddress(a: AddressRow): Stripe.AddressParam {
  return {
    line1: a.line1,
    line2: a.line2 ?? '',
    city: a.city,
    state: a.state ?? '',
    postal_code: a.postalCode,
    country: a.country,
  };
}

/**
 * The ONE Stripe Customer per TradeW user.
 *
 *  · Created with `metadata.applicationUserId` and an idempotency key derived
 *    from the user id, so concurrent or repeated attempts within Stripe's
 *    24-hour idempotency window return the same customer instead of a second.
 *  · The id is stored on `User.stripeCustomerId` (unique) and is the only key
 *    ever used to reach the customer. It is never looked up by email.
 *  · Provisioning NEVER fails registration. A Stripe outage records a
 *    sanitised error on the user row; a background sweep retries, and every
 *    billing call runs `ensureCustomer` first, so the account self-heals.
 *  · If Stripe created the customer but our database write was lost, the
 *    `customer.created` webhook (which carries `applicationUserId`) re-links
 *    it, and a retry after a recorded error searches by that metadata before
 *    creating, so the user still ends up with exactly one customer.
 */
@Injectable()
export class StripeCustomerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StripeCustomerService.name);
  private readonly inflight = new Map<string, Promise<string>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StripeGateway,
    // Optional so scripts and tests can construct the service directly. In the
    // app it is always present, and the sweep runs on the lease holder only, so
    // N replicas do not retry the same customers N times.
    @Optional() private readonly leader?: LeaderElectionService,
  ) {}

  onModuleInit() {
    if (!this.gateway.enabled || !this.leader || process.env.NODE_ENV === 'test' || process.env.STRIPE_RETRY_SWEEP === 'false') return;
    this.leader.register(SWEEP_JOB);
    this.sweepTimer = setInterval(() => {
      if (this.leader?.isLeader(SWEEP_JOB)) void this.sweep().catch(() => undefined);
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Fire-and-forget provisioning for signup paths. Never throws. */
  provisionInBackground(userId: string): void {
    if (!this.gateway.enabled) return;
    void this.ensureCustomer(userId).catch(() => undefined);
  }

  /** Fire-and-forget profile/address sync. Never throws. */
  syncInBackground(userId: string): void {
    if (!this.gateway.enabled) return;
    void this.syncCustomer(userId).catch(() => undefined);
  }

  /**
   * Return the user's Stripe Customer id, creating the customer if needed.
   * Concurrent calls for one user share a single in-flight promise.
   */
  async ensureCustomer(userId: string): Promise<string> {
    const existing = this.inflight.get(userId);
    if (existing) return existing;
    const p = this.ensureCustomerOnce(userId).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, p);
    return p;
  }

  private async ensureCustomerOnce(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, lastName: true, stripeCustomerId: true, stripeCustomerError: true },
    });
    if (!user) throw new ServiceUnavailableException('Account not found.');
    if (user.stripeCustomerId) return user.stripeCustomerId;

    const stripe = this.gateway.stripe;
    const addresses = await this.prisma.customerAddress.findMany({ where: { userId } });
    const billing = addresses.find((a) => a.kind === 'billing');
    const shipping = addresses.find((a) => a.kind === 'shipping');

    try {
      // A previous attempt failed: before creating, check whether Stripe has
      // a customer tagged with this user (created, then our write was lost).
      let customer: Stripe.Customer | null = null;
      if (user.stripeCustomerError) {
        const found = await stripe.customers.search({ query: `metadata['applicationUserId']:'${user.id}'`, limit: 1 });
        customer = found.data[0] ?? null;
      }
      if (!customer) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
        customer = await stripe.customers.create(
          {
            email: user.email.endsWith('@phone.tradew.local') ? undefined : user.email,
            name,
            phone: billing?.phone ?? undefined,
            address: billing ? toStripeAddress(billing) : undefined,
            shipping: shipping ? { name: shipping.name, phone: shipping.phone ?? undefined, address: toStripeAddress(shipping) } : undefined,
            metadata: { applicationUserId: user.id },
            preferred_locales: ['en'],
          },
          { idempotencyKey: `tradew-customer-create-${user.id}` },
        );
      }

      // Conditional write: only the first writer wins, so two racing creators
      // (which got the same customer from the idempotency key) agree.
      await this.prisma.user.updateMany({
        where: { id: user.id, stripeCustomerId: null },
        data: { stripeCustomerId: customer.id, stripeCustomerSyncedAt: new Date(), stripeCustomerError: null },
      });
      const after = await this.prisma.user.findUnique({ where: { id: user.id }, select: { stripeCustomerId: true } });
      await billingAudit(this.prisma, 'customer.provisioned', user.id, { customerId: after?.stripeCustomerId });
      return after!.stripeCustomerId!;
    } catch (err) {
      const reason = describeStripeError(err);
      this.logger.warn(`Stripe customer provisioning failed for user ${user.id}: ${reason}`);
      await this.prisma.user
        .update({ where: { id: user.id }, data: { stripeCustomerError: reason.slice(0, 300) } })
        .catch(() => undefined);
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'billing_profile_unavailable',
        message: 'Billing is temporarily unavailable. Your account is fine. Please try again in a moment.',
      });
    }
  }

  /**
   * Push name, email, phone and addresses to the Stripe Customer. Records the
   * outcome per address row (`stripeSyncedAt` / `stripeSyncError`) so a
   * mismatch between TradeW and Stripe is visible, never silent.
   * Returns true when Stripe accepted the update.
   */
  async syncCustomer(userId: string): Promise<boolean> {
    const customerId = await this.ensureCustomer(userId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });
    const addresses = await this.prisma.customerAddress.findMany({ where: { userId } });
    const billing = addresses.find((a) => a.kind === 'billing');
    const shipping = addresses.find((a) => a.kind === 'shipping');
    const params: Stripe.CustomerUpdateParams = {
      name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || undefined,
      email: user?.email && !user.email.endsWith('@phone.tradew.local') ? user.email : undefined,
      ...(billing ? { address: toStripeAddress(billing), phone: billing.phone ?? '' } : {}),
      shipping: shipping ? { name: shipping.name, phone: shipping.phone ?? undefined, address: toStripeAddress(shipping) } : '',
    };
    try {
      const customer = await this.gateway.stripe.customers.update(customerId, params);
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { stripeCustomerSyncedAt: now, stripeCustomerError: null } }),
        this.prisma.customerAddress.updateMany({ where: { userId }, data: { stripeSyncedAt: now, stripeSyncError: null } }),
      ]);
      // Keep the default card's billing details in step with the billing
      // address, so Stripe's address checks see the same address as tax does.
      const defaultPm = customer.invoice_settings?.default_payment_method;
      if (billing && typeof defaultPm === 'string') {
        await this.gateway.stripe.paymentMethods
          .update(defaultPm, {
            billing_details: { name: billing.name, phone: billing.phone ?? undefined, address: toStripeAddress(billing) },
          })
          .catch((e) => this.logger.warn(`default card billing_details sync failed: ${describeStripeError(e)}`));
      }
      return true;
    } catch (err) {
      const reason = describeStripeError(err).slice(0, 300);
      this.logger.warn(`Stripe customer sync failed for user ${userId}: ${reason}`);
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { stripeCustomerError: reason } }),
        this.prisma.customerAddress.updateMany({ where: { userId }, data: { stripeSyncError: 'Not yet saved to the payment provider. Retrying automatically.' } }),
      ]);
      return false;
    }
  }

  /**
   * Retry sweep: users whose provisioning or sync failed. Runs every ten
   * minutes in a server with Stripe configured; also callable from scripts.
   */
  async sweep(): Promise<{ retried: number; healed: number }> {
    if (!this.gateway.enabled) return { retried: 0, healed: 0 };
    const pending = await this.prisma.user.findMany({
      where: { OR: [{ stripeCustomerError: { not: null } }, { addresses: { some: { stripeSyncError: { not: null } } } }] },
      select: { id: true },
      take: SWEEP_BATCH,
    });
    let healed = 0;
    for (const { id } of pending) {
      const ok = await this.syncCustomer(id).catch(() => false);
      if (ok) healed += 1;
    }
    return { retried: pending.length, healed };
  }

  /** Webhook recovery: link a customer Stripe reports for one of our users. */
  async linkFromWebhook(customer: Stripe.Customer): Promise<void> {
    const appUserId = customer.metadata?.applicationUserId;
    if (!appUserId) return;
    const res = await this.prisma.user.updateMany({
      where: { id: appUserId, stripeCustomerId: null },
      data: { stripeCustomerId: customer.id, stripeCustomerSyncedAt: new Date(), stripeCustomerError: null },
    });
    if (res.count) await billingAudit(this.prisma, 'customer.relinked_from_webhook', appUserId, { customerId: customer.id });
    else await this.prisma.user.updateMany({ where: { id: appUserId, stripeCustomerId: customer.id }, data: { stripeCustomerSyncedAt: new Date() } });
  }

  async userIdForCustomer(customerId: string | null | undefined): Promise<string | null> {
    if (!customerId) return null;
    const u = await this.prisma.user.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    return u?.id ?? null;
  }
}
