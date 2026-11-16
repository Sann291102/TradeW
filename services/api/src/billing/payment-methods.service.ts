import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../mail/email.service';
import { StripeGateway } from './stripe.gateway';
import { StripeCustomerService } from './stripe-customer.service';
import { toClientError } from './stripe-errors';
import { billingAudit } from './billing-audit';
import { nowLabel } from './customer.service';

export interface CardView {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  expired: boolean;
}

export function cardLabel(brand: string, last4: string): string {
  const pretty = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
  return `${pretty} ending ${last4}`;
}

/**
 * Saved cards. Stripe holds the card data; TradeW holds only the Stripe id,
 * brand, last4 and expiry (the same fields Stripe returns to any caller with
 * the secret key), mirrored in `SavedPaymentMethod` for ownership checks and
 * the audit trail.
 *
 * Adding a card goes through a SetupIntent confirmed by Stripe.js in the
 * browser (Payment Element), which also runs 3-D Secure when the bank asks
 * for it. No card number or CVC ever reaches this server.
 *
 * Every operation on a payment method first proves it is attached to the
 * caller's own Stripe Customer. A method belonging to someone else answers 404
 * exactly like one that does not exist.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StripeGateway,
    private readonly customers: StripeCustomerService,
    private readonly email: EmailService,
  ) {}

  private view(pm: Stripe.PaymentMethod, defaultId: string | null): CardView | null {
    if (pm.type !== 'card' || !pm.card) return null;
    const now = new Date();
    const expired = pm.card.exp_year < now.getUTCFullYear() || (pm.card.exp_year === now.getUTCFullYear() && pm.card.exp_month < now.getUTCMonth() + 1);
    return {
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      isDefault: pm.id === defaultId,
      expired,
    };
  }

  private async defaultId(customerId: string): Promise<string | null> {
    const customer = await this.gateway.stripe.customers.retrieve(customerId);
    if ((customer as Stripe.DeletedCustomer).deleted) return null;
    const def = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
    return typeof def === 'string' ? def : def?.id ?? null;
  }

  async list(userId: string): Promise<{ cards: CardView[] }> {
    try {
      const customerId = await this.customers.ensureCustomer(userId);
      const [methods, defaultId] = await Promise.all([
        this.gateway.stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 30 }),
        this.defaultId(customerId),
      ]);
      const cards = methods.data.map((pm) => this.view(pm, defaultId)).filter((c): c is CardView => c !== null);
      await this.mirror(userId, cards);
      return { cards };
    } catch (err) {
      throw toClientError(err, 'list payment methods');
    }
  }

  /** Bring the local mirror in line with what Stripe just reported. */
  private async mirror(userId: string, cards: CardView[]) {
    const ids = cards.map((c) => c.id);
    for (const c of cards) {
      await this.prisma.savedPaymentMethod.upsert({
        where: { stripePaymentMethodId: c.id },
        create: { userId, stripePaymentMethodId: c.id, brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, isDefault: c.isDefault },
        update: { brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, isDefault: c.isDefault, detachedAt: null },
      });
    }
    await this.prisma.savedPaymentMethod.updateMany({
      where: { userId, detachedAt: null, stripePaymentMethodId: { notIn: ids.length ? ids : ['__none__'] } },
      data: { detachedAt: new Date(), isDefault: false },
    });
  }

  /** Start "add a card": a SetupIntent the Payment Element confirms in the browser. */
  async createSetupIntent(userId: string): Promise<{ clientSecret: string; setupIntentId: string }> {
    try {
      const customerId = await this.customers.ensureCustomer(userId);
      const si = await this.gateway.stripe.setupIntents.create(
        {
          customer: customerId,
          usage: 'off_session',
          allowed_payment_method_types: ['card'],
          metadata: { applicationUserId: userId },
        },
        { idempotencyKey: `tradew-setup-${userId}-${randomUUID()}` },
      );
      await billingAudit(this.prisma, 'setup_intent.created', userId, { setupIntentId: si.id });
      return { clientSecret: si.client_secret!, setupIntentId: si.id };
    } catch (err) {
      throw toClientError(err, 'create setup intent');
    }
  }

  /** Load a payment method and prove it belongs to this user's customer. */
  async ownedPaymentMethod(userId: string, paymentMethodId: string): Promise<{ pm: Stripe.PaymentMethod; customerId: string }> {
    if (!/^pm_[A-Za-z0-9]+$/.test(paymentMethodId)) throw new NotFoundException('Payment method not found.');
    const customerId = await this.customers.ensureCustomer(userId);
    let pm: Stripe.PaymentMethod;
    try {
      pm = await this.gateway.stripe.paymentMethods.retrieve(paymentMethodId);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError) throw new NotFoundException('Payment method not found.');
      throw toClientError(err, 'retrieve payment method');
    }
    const owner = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id;
    if (owner !== customerId) {
      await billingAudit(this.prisma, 'payment_method.ownership_denied', userId, { paymentMethodId });
      throw new NotFoundException('Payment method not found.');
    }
    return { pm, customerId };
  }

  async remove(userId: string, paymentMethodId: string): Promise<{ cards: CardView[] }> {
    const { pm, customerId } = await this.ownedPaymentMethod(userId, paymentMethodId);
    try {
      // Removing the only card while a subscription will renew would make the
      // next renewal fail. Ask for a replacement (or a cancellation) first.
      const cards = await this.gateway.stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 30 });
      if (cards.data.length <= 1) {
        const renewing = await this.prisma.subscription.count({
          where: { userId, billingProvider: 'stripe', cancelAtPeriodEnd: false, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
        });
        if (renewing > 0) {
          throw new ConflictException('This is the card your subscription renews with. Add another card first, or cancel the subscription.');
        }
      }
      await this.gateway.stripe.paymentMethods.detach(pm.id);
      await this.prisma.savedPaymentMethod.updateMany({
        where: { stripePaymentMethodId: pm.id },
        data: { detachedAt: new Date(), isDefault: false },
      });
      await billingAudit(this.prisma, 'payment_method.detached', userId, { paymentMethodId: pm.id, brand: pm.card?.brand, last4: pm.card?.last4 });
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      this.email.dispatch(
        'payment_method_removed',
        user?.email,
        { CardLabel: cardLabel(pm.card?.brand ?? '', pm.card?.last4 ?? '????'), When: nowLabel() },
        { userId },
      );
    } catch (err) {
      throw toClientError(err, 'detach payment method');
    }
    return this.list(userId);
  }

  async setDefault(userId: string, paymentMethodId: string): Promise<{ cards: CardView[] }> {
    const { pm, customerId } = await this.ownedPaymentMethod(userId, paymentMethodId);
    try {
      await this.gateway.stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
      // Subscriptions created through checkout carry their own default
      // payment method, which overrides the customer's. Move those too, so
      // "default card" means the card renewals are actually charged to.
      const subs = await this.gateway.stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 20 });
      for (const sub of subs.data) {
        await this.gateway.stripe.subscriptions.update(sub.id, { default_payment_method: pm.id });
      }
      await billingAudit(this.prisma, 'payment_method.default_set', userId, { paymentMethodId: pm.id });
    } catch (err) {
      throw toClientError(err, 'set default payment method');
    }
    return this.list(userId);
  }

  // ---------------------------------------------------------------- webhooks

  async onAttached(pm: Stripe.PaymentMethod): Promise<void> {
    const customerId = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id;
    const userId = await this.customers.userIdForCustomer(customerId);
    if (!userId || pm.type !== 'card' || !pm.card) return;
    const existing = await this.prisma.savedPaymentMethod.findUnique({ where: { stripePaymentMethodId: pm.id } });
    await this.prisma.savedPaymentMethod.upsert({
      where: { stripePaymentMethodId: pm.id },
      create: { userId, stripePaymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year },
      update: { detachedAt: null },
    });
    if (!existing || existing.detachedAt) {
      await billingAudit(this.prisma, 'payment_method.attached', userId, { paymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4 });
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      this.email.dispatch(
        'payment_method_added',
        user?.email,
        {
          CardLabel: cardLabel(pm.card.brand, pm.card.last4),
          CardExpiry: `${String(pm.card.exp_month).padStart(2, '0')}/${pm.card.exp_year}`,
          When: nowLabel(),
        },
        { userId },
      );
    }
  }

  async onDetached(pm: Stripe.PaymentMethod): Promise<void> {
    await this.prisma.savedPaymentMethod.updateMany({
      where: { stripePaymentMethodId: pm.id, detachedAt: null },
      data: { detachedAt: new Date(), isDefault: false },
    });
  }

  /** A card saved through "Add card": make it the default if there is none. */
  async onSetupIntentSucceeded(si: Stripe.SetupIntent): Promise<void> {
    const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id;
    const pmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
    if (!customerId || !pmId) return;
    const userId = await this.customers.userIdForCustomer(customerId);
    if (!userId) return;
    // Cards saved deliberately may be shown again in future checkouts.
    await this.gateway.stripe.paymentMethods.update(pmId, { allow_redisplay: 'always' }).catch(() => undefined);
    const current = await this.defaultId(customerId);
    if (!current) {
      await this.gateway.stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } });
      await this.prisma.savedPaymentMethod.updateMany({ where: { stripePaymentMethodId: pmId }, data: { isDefault: true } });
    }
    await billingAudit(this.prisma, 'setup_intent.succeeded', userId, { setupIntentId: si.id, paymentMethodId: pmId });
  }
}
