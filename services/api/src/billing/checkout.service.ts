import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BillingOrder, Prisma } from '@prisma/client';
import Stripe = require('stripe');
import { SENTINEL_TRIAL } from '@tradew/types';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { StripeGateway } from './stripe.gateway';
import { StripeCustomerService } from './stripe-customer.service';
import { StripePriceService } from './stripe-price.service';
import { PaymentMethodsService } from './payment-methods.service';
import { CustomerService } from './customer.service';
import { toClientError, describeStripeError } from './stripe-errors';
import { billingAudit } from './billing-audit';
import {
  BILLING_CURRENCY,
  BILLING_ITEMS,
  TRIAL_ITEM,
  TRIAL_PERIOD_KEY,
  billingItem,
  chargeFor,
  formatMinor,
  priceLabel,
  type BillingItem,
} from './billing.catalog';

export interface TaxLine {
  label: string;
  amountMinor: number;
  ratePercent: string | null;
  taxabilityReason: string | null;
}

export interface Quote {
  itemId: string;
  label: string;
  kind: BillingItem['kind'];
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxLines: TaxLine[];
  /** Plain-language note when tax is zero, so $0.00 is never ambiguous. */
  taxNote: string | null;
  taxCalculationId: string | null;
  billingAddressSummary: string;
}

export interface CreateCheckoutInput {
  itemId: string;
  /** One-time items only: keep the card for future purchases. */
  savePaymentMethod?: boolean;
  /** Pay with a saved card (must belong to the caller). */
  paymentMethodId?: string;
  /** Client-generated UUID, one per checkout attempt. Same key → same order. */
  idempotencyKey: string;
}

/**
 * Checkout. Two shapes, chosen by the catalog:
 *
 *  · RECURRING (Learning, Sentinel Pro 1/3/6 months): a Stripe Billing
 *    subscription created `default_incomplete` with `automatic_tax`, whose
 *    first invoice's PaymentIntent the browser confirms with the Payment
 *    Element. Renewals are charged by Stripe and arrive as `invoice.paid`.
 *  · ONE-TIME (the 7-day pass): a PaymentIntent whose amount is the total of a
 *    Stripe Tax calculation. `setup_future_usage` is set ONLY when the
 *    customer ticks "save this card".
 *
 * In both, every amount is computed here from the catalog in cents; the
 * request carries an item id, never a price. Orders are created `pending` and
 * become `paid` only in the webhook handler (`BillingFulfilmentService`).
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StripeGateway,
    private readonly customers: StripeCustomerService,
    private readonly prices: StripePriceService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly entitlements: EntitlementsService,
    customerProfile: CustomerService,
  ) {
    // Re-price open one-time orders when the billing address changes.
    customerProfile.onBillingAddressChanged((userId) => this.recalculatePendingOrders(userId));
  }

  /** Public catalog: prices, mode, publishable key. No per-user state. */
  catalog() {
    return {
      currency: 'USD',
      billingEnabled: this.gateway.enabled,
      mode: this.gateway.mode,
      publishableKey: this.gateway.publishableKey,
      items: BILLING_ITEMS.map((i) => ({
        id: i.id,
        label: i.label,
        product: i.product,
        kind: i.kind,
        amountMinor: i.amountMinor,
        amountLabel: formatMinor(i.amountMinor),
        priceLabel: priceLabel(i),
        intervalCount: i.intervalCount ?? null,
        days: i.days ?? null,
        // Local-currency prices (e.g. Learning ₹499 for Indian billing
        // addresses). Which one applies is decided server-side at checkout.
        localPrices: (i.localPrices ?? []).map((l) => ({
          country: l.country,
          currency: l.currency.toUpperCase(),
          amountMinor: l.amountMinor,
          label: `${formatMinor(l.amountMinor, l.currency)}${i.kind === 'recurring' && i.intervalCount === 1 ? '/month' : ''}`,
        })),
      })),
      trial: {
        id: TRIAL_ITEM.id,
        label: TRIAL_ITEM.label,
        days: SENTINEL_TRIAL.days,
        amountMinor: TRIAL_ITEM.amountMinor,
        amountLabel: formatMinor(TRIAL_ITEM.amountMinor),
        dailyRateLabel: formatMinor(SENTINEL_TRIAL.dailyRate),
        discountPct: SENTINEL_TRIAL.discountPct,
      },
      taxNote: 'Sales tax is calculated from your billing address and added at checkout.',
      notice: this.gateway.enabled ? undefined : 'Payments are not enabled yet. No account can be charged.',
    };
  }

  async trialStatus(userId: string): Promise<{ eligible: boolean; reason: 'available' | 'already_claimed' | 'already_subscribed' }> {
    if (await this.hasClaimed(userId, TRIAL_ITEM)) return { eligible: false, reason: 'already_claimed' };
    const decision = await this.entitlements.check(userId, 'sentinel');
    if (decision.allowed) return { eligible: false, reason: 'already_subscribed' };
    return { eligible: true, reason: 'available' };
  }

  private item(itemId: string): BillingItem {
    const item = billingItem(itemId);
    if (!item) throw new BadRequestException('Unknown item.');
    return item;
  }

  private async billingAddress(userId: string) {
    const address = await this.prisma.customerAddress.findUnique({ where: { userId_kind: { userId, kind: 'billing' } } });
    if (!address) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'billing_address_required',
        message: 'Add your billing address first. Sales tax depends on where you are.',
      });
    }
    if (address.stripeSyncError) {
      // The address is saved locally but Stripe has not got it yet, so tax
      // would be computed from a stale (or missing) Stripe address. Try once
      // more now; refuse rather than charge tax for the wrong place.
      const ok = await this.customers.syncCustomer(userId).catch(() => false);
      if (!ok) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'billing_address_not_synced',
          message: 'Your billing address has not reached the payment provider yet. Please try again in a moment.',
        });
      }
    }
    return address;
  }

  // ---------------------------------------------------------------- tax

  private async taxLinesFromCalculation(calc: Stripe.Tax.Calculation): Promise<TaxLine[]> {
    return calc.tax_breakdown
      .filter((b) => b.amount > 0 || b.taxability_reason !== 'not_collecting')
      .map((b) => ({
        label: [b.tax_rate_details.tax_type?.replace(/_/g, ' ').toUpperCase() ?? 'Tax', b.tax_rate_details.state, b.tax_rate_details.country]
          .filter(Boolean)
          .join(' · '),
        amountMinor: b.amount,
        ratePercent: b.tax_rate_details.percentage_decimal ?? null,
        taxabilityReason: b.taxability_reason ?? null,
      }));
  }

  private async taxLinesFromInvoice(invoice: Stripe.Invoice): Promise<TaxLine[]> {
    const lines: TaxLine[] = [];
    for (const t of invoice.total_taxes ?? []) {
      let label = 'Sales tax';
      let ratePercent: string | null = null;
      const rateId = t.tax_rate_details?.tax_rate;
      if (rateId) {
        const rate = await this.gateway.stripe.taxRates.retrieve(rateId).catch(() => null);
        if (rate) {
          label = [rate.display_name, rate.jurisdiction].filter(Boolean).join(' · ');
          ratePercent = rate.percentage != null ? String(rate.percentage) : null;
        }
      }
      lines.push({ label, amountMinor: t.amount, ratePercent, taxabilityReason: t.taxability_reason ?? null });
    }
    return lines;
  }

  private taxNote(taxMinor: number, lines: TaxLine[]): string | null {
    if (taxMinor > 0) return null;
    const reason = lines[0]?.taxabilityReason;
    if (reason === 'not_collecting') return 'No sales tax: TradeW is not registered to collect tax in your location.';
    if (reason === 'product_exempt' || reason === 'not_subject_to_tax') return 'No sales tax applies to this purchase in your location.';
    return 'No sales tax was calculated for your location.';
  }

  /** Tax calculation for a one-time item, from the customer's billing address. */
  private async calculateOneTimeTax(customerId: string, item: BillingItem): Promise<Stripe.Tax.Calculation> {
    return this.gateway.stripe.tax.calculations.create({
      currency: item.currency,
      // The customer's address (synced from the billing address) is the tax
      // location. Stripe takes `customer` OR `customer_details`, never both.
      customer: customerId,
      line_items: [
        { amount: item.amountMinor, quantity: 1, reference: item.id, tax_code: this.prices.taxCodeFor(item), tax_behavior: 'exclusive' },
      ],
    });
  }

  /** Server-calculated price, tax and total for one item. Nothing is charged. */
  async quote(userId: string, itemId: string): Promise<Quote> {
    const item = this.item(itemId);
    const address = await this.billingAddress(userId);
    const summary = [address.line1, address.city, address.state, address.postalCode, address.country].filter(Boolean).join(', ');
    try {
      const customerId = await this.customers.ensureCustomer(userId);
      if (item.kind === 'one_time') {
        const calc = await this.calculateOneTimeTax(customerId, item);
        const taxLines = await this.taxLinesFromCalculation(calc);
        return {
          itemId: item.id,
          label: item.label,
          kind: item.kind,
          currency: item.currency,
          subtotalMinor: item.amountMinor,
          taxMinor: calc.tax_amount_exclusive,
          totalMinor: calc.amount_total,
          taxLines,
          taxNote: this.taxNote(calc.tax_amount_exclusive, taxLines),
          taxCalculationId: calc.id ?? null,
          billingAddressSummary: summary,
        };
      }
      const price = await this.prices.resolve(item);
      const charge = chargeFor(item, address.country);
      const preview = await this.gateway.stripe.invoices.createPreview({
        customer: customerId,
        // Learning bills ₹499 to an Indian billing address, $4.99 elsewhere,
        // from the same Price's currency_options.
        currency: charge.currency,
        automatic_tax: { enabled: true },
        subscription_details: { items: [{ price: price.id, quantity: 1 }] },
      });
      const taxMinor = (preview.total_taxes ?? []).reduce((s, t) => s + t.amount, 0);
      const taxLines = await this.taxLinesFromInvoice(preview);
      return {
        itemId: item.id,
        label: item.label,
        kind: item.kind,
        currency: preview.currency,
        subtotalMinor: preview.subtotal,
        taxMinor,
        totalMinor: preview.total,
        taxLines,
        taxNote: this.taxNote(taxMinor, taxLines),
        taxCalculationId: null,
        billingAddressSummary: summary,
      };
    } catch (err) {
      throw toClientError(err, `quote ${itemId}`);
    }
  }

  // ---------------------------------------------------------------- create

  async create(userId: string, input: CreateCheckoutInput) {
    const item = this.item(input.itemId);
    const key = `${userId}:${input.idempotencyKey}`;

    // Double-submit: the same attempt key returns the same order and the same
    // client secret, never a second charge.
    const prior = await this.prisma.billingOrder.findUnique({ where: { idempotencyKey: key } });
    if (prior) {
      if (prior.userId !== userId || prior.itemId !== item.id) throw new ConflictException('That checkout key was already used.');
      return this.resume(prior);
    }

    const address = await this.billingAddress(userId);
    const charge = chargeFor(item, address.country);
    if (item.oncePerUser && (await this.hasClaimed(userId, item))) {
      throw new BadRequestException('You have already used your one-time trial.');
    }
    if (item.kind === 'recurring') await this.assertNotAlreadySubscribed(userId, item);

    const customerId = await this.customers.ensureCustomer(userId);
    if (input.paymentMethodId) await this.paymentMethods.ownedPaymentMethod(userId, input.paymentMethodId);

    const order = await this.prisma.billingOrder.create({
      data: {
        userId,
        itemId: item.id,
        kind: item.kind === 'recurring' ? 'subscription' : 'one_time',
        currency: charge.currency,
        subtotalMinor: charge.amountMinor,
        totalMinor: charge.amountMinor,
        idempotencyKey: key,
        savePaymentMethod: item.kind === 'one_time' ? Boolean(input.savePaymentMethod) : true,
      },
    });
    await billingAudit(this.prisma, 'checkout.created', userId, { orderId: order.id, itemId: item.id });

    try {
      return item.kind === 'recurring'
        ? await this.createSubscription(order, item, customerId, input.paymentMethodId, charge.currency)
        : await this.createOneTime(order, item, customerId, input);
    } catch (err) {
      await this.prisma.billingOrder.update({
        where: { id: order.id },
        data: { status: 'failed', failureReason: describeStripeError(err).slice(0, 300) },
      });
      throw toClientError(err, `checkout ${item.id}`);
    }
  }

  private async createOneTime(order: BillingOrder, item: BillingItem, customerId: string, input: CreateCheckoutInput) {
    const stripe = this.gateway.stripe;
    const calc = await this.calculateOneTimeTax(customerId, item);
    const pi = await stripe.paymentIntents.create(
      {
        amount: calc.amount_total,
        currency: item.currency,
        customer: customerId,
        // Cards only, regardless of what the Dashboard enables.
        allowed_payment_method_types: ['card'],
        description: item.label,
        metadata: { orderId: order.id, userId: order.userId, itemId: item.id, taxCalculationId: calc.id ?? '' },
        // Explicit consent only. Unticked → the card is used once and is not
        // attached to the customer or reusable.
        ...(input.savePaymentMethod ? { setup_future_usage: 'off_session' as const } : {}),
        ...(input.paymentMethodId ? { payment_method: input.paymentMethodId } : {}),
      },
      { idempotencyKey: `tradew-pi-${order.id}` },
    );
    const taxLines = await this.taxLinesFromCalculation(calc);
    const updated = await this.prisma.billingOrder.update({
      where: { id: order.id },
      data: {
        stripePaymentIntentId: pi.id,
        paymentStatus: pi.status,
        taxMinor: calc.tax_amount_exclusive,
        totalMinor: calc.amount_total,
        taxCalculationId: calc.id ?? null,
        taxBreakdown: taxLines as unknown as Prisma.InputJsonValue,
      },
    });
    return this.checkoutResponse(updated, pi.client_secret, taxLines);
  }

  private async createSubscription(order: BillingOrder, item: BillingItem, customerId: string, paymentMethodId: string | undefined, currency: string) {
    const stripe = this.gateway.stripe;
    const price = await this.prices.resolve(item);
    const sub = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: price.id, quantity: 1 }],
        currency,
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
        automatic_tax: { enabled: true },
        ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
        metadata: { orderId: order.id, userId: order.userId, itemId: item.id },
        expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payments'],
      },
      { idempotencyKey: `tradew-sub-${order.id}` },
    );
    const invoice = sub.latest_invoice as Stripe.Invoice | null;
    if (!invoice) throw new Error(`subscription ${sub.id} has no first invoice`);
    const taxMinor = (invoice.total_taxes ?? []).reduce((s, t) => s + t.amount, 0);
    const taxLines = await this.taxLinesFromInvoice(invoice);
    const piId = firstInvoicePaymentIntentId(invoice);
    const updated = await this.prisma.billingOrder.update({
      where: { id: order.id },
      data: {
        stripeSubscriptionId: sub.id,
        stripeInvoiceId: invoice.id ?? null,
        stripePriceId: price.id,
        stripePaymentIntentId: piId,
        paymentStatus: invoice.status ?? null,
        currency: invoice.currency,
        subtotalMinor: invoice.subtotal,
        taxMinor,
        totalMinor: invoice.total,
        taxBreakdown: taxLines as unknown as Prisma.InputJsonValue,
      },
    });
    return this.checkoutResponse(updated, invoice.confirmation_secret?.client_secret ?? null, taxLines);
  }

  /** Re-open an existing attempt (double-submit or page reload). */
  private async resume(order: BillingOrder) {
    const stripe = this.gateway.stripe;
    let clientSecret: string | null = null;
    try {
      if (order.kind === 'one_time' && order.stripePaymentIntentId) {
        clientSecret = (await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)).client_secret;
      } else if (order.stripeInvoiceId) {
        const inv = await stripe.invoices.retrieve(order.stripeInvoiceId, { expand: ['confirmation_secret'] });
        clientSecret = inv.confirmation_secret?.client_secret ?? null;
      }
    } catch (err) {
      throw toClientError(err, 'resume checkout');
    }
    return this.checkoutResponse(order, clientSecret, (order.taxBreakdown as unknown as TaxLine[]) ?? []);
  }

  private checkoutResponse(order: BillingOrder, clientSecret: string | null, taxLines: TaxLine[]) {
    return {
      orderId: order.id,
      status: order.status,
      kind: order.kind,
      clientSecret,
      publishableKey: this.gateway.publishableKey,
      currency: order.currency,
      subtotalMinor: order.subtotalMinor,
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
      taxLines,
      taxNote: this.taxNote(order.taxMinor, taxLines),
    };
  }

  private async assertNotAlreadySubscribed(userId: string, item: BillingItem) {
    const live = await this.prisma.subscription.findFirst({
      where: {
        userId,
        billingProvider: 'stripe',
        plan: { code: item.planCode },
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (live) {
      throw new ConflictException(
        live.cancelAtPeriodEnd
          ? 'Your subscription is set to end. Resume it from Billing instead of buying again.'
          : 'You already have an active subscription to this plan.',
      );
    }
  }

  // ---------------------------------------------------------------- read

  private orderView(o: BillingOrder) {
    const item = billingItem(o.itemId);
    return {
      id: o.id,
      itemId: o.itemId,
      label: item?.label ?? o.itemId,
      kind: o.kind,
      status: o.status,
      paymentStatus: o.paymentStatus,
      currency: o.currency,
      subtotalMinor: o.subtotalMinor,
      taxMinor: o.taxMinor,
      totalMinor: o.totalMinor,
      refundedMinor: o.refundedMinor,
      taxLines: (o.taxBreakdown as unknown as TaxLine[]) ?? [],
      savePaymentMethod: o.savePaymentMethod,
      failureReason: o.failureReason,
      paidAt: o.paidAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
      accessPath: item?.accessPath ?? '/dashboard',
    };
  }

  async getOrder(userId: string, orderId: string) {
    const order = await this.prisma.billingOrder.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('Order not found.');
    return this.orderView(order);
  }

  /**
   * After Stripe.js finishes confirming, the page calls this to learn where
   * the payment stands. It refreshes the RAW Stripe status for display
   * (`processing`, `requires_action`, ...) but never marks an order paid:
   * that only happens when the signed webhook arrives.
   */
  async confirm(userId: string, orderId: string) {
    const order = await this.prisma.billingOrder.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('Order not found.');
    if (order.status === 'pending' || order.status === 'processing') {
      try {
        if (order.stripePaymentIntentId) {
          const pi = await this.gateway.stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
          const status = pi.status === 'processing' || pi.status === 'succeeded' ? 'processing' : order.status;
          await this.prisma.billingOrder.update({ where: { id: order.id }, data: { paymentStatus: pi.status, status } });
        } else if (order.stripeInvoiceId) {
          const inv = await this.gateway.stripe.invoices.retrieve(order.stripeInvoiceId, { expand: ['payments'] });
          const piId = firstInvoicePaymentIntentId(inv);
          await this.prisma.billingOrder.update({
            where: { id: order.id },
            data: { paymentStatus: inv.status ?? order.paymentStatus, ...(piId ? { stripePaymentIntentId: piId } : {}) },
          });
        }
      } catch (err) {
        this.logger.warn(`confirm refresh for ${order.id} failed: ${describeStripeError(err)}`);
      }
    }
    return this.getOrder(userId, orderId);
  }

  async listOrders(userId: string) {
    const orders = await this.prisma.billingOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { orders: orders.map((o) => this.orderView(o)) };
  }

  async listSubscriptions(userId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { userId },
      include: { plan: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      subscriptions: subs.map((s) => ({
        id: s.id,
        plan: s.plan.name,
        planCode: s.plan.code,
        status: s.status,
        provider: s.billingProvider,
        renews: s.billingProvider === 'stripe' && s.billingReference?.startsWith('sub_') ? !s.cancelAtPeriodEnd : false,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        expiresAt: s.expiresAt?.toISOString() ?? null,
        startedAt: s.startedAt.toISOString(),
      })),
    };
  }

  /** Cancel at period end (access continues until it), or resume. */
  async setCancelAtPeriodEnd(userId: string, subscriptionId: string, cancel: boolean) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.userId !== userId) throw new NotFoundException('Subscription not found.');
    if (sub.billingProvider !== 'stripe' || !sub.billingReference?.startsWith('sub_')) {
      throw new BadRequestException('This plan does not renew automatically, so there is nothing to cancel.');
    }
    try {
      await this.gateway.stripe.subscriptions.update(sub.billingReference, { cancel_at_period_end: cancel });
    } catch (err) {
      throw toClientError(err, 'update subscription');
    }
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: cancel, canceledAt: cancel ? new Date() : null },
    });
    await billingAudit(this.prisma, cancel ? 'subscription.cancel_scheduled' : 'subscription.resumed', userId, { subscriptionId: sub.billingReference });
    return this.listSubscriptions(userId);
  }

  // ---------------------------------------------------------------- tax recalc

  /**
   * The billing address changed: tax on any one-time order that has not been
   * paid yet was computed for the old address. Recalculate and update the
   * PaymentIntent amount so it always equals the new total. (Subscription
   * invoices are taxed by Stripe from the customer address at finalisation.)
   */
  async recalculatePendingOrders(userId: string): Promise<void> {
    if (!this.gateway.enabled) return;
    const open = await this.prisma.billingOrder.findMany({
      where: { userId, kind: 'one_time', status: 'pending', stripePaymentIntentId: { not: null } },
    });
    if (!open.length) return;
    const customerId = await this.customers.ensureCustomer(userId);
    for (const order of open) {
      const item = billingItem(order.itemId);
      if (!item) continue;
      try {
        const pi = await this.gateway.stripe.paymentIntents.retrieve(order.stripePaymentIntentId!);
        if (!['requires_payment_method', 'requires_confirmation'].includes(pi.status)) continue;
        const calc = await this.calculateOneTimeTax(customerId, item);
        await this.gateway.stripe.paymentIntents.update(pi.id, {
          amount: calc.amount_total,
          metadata: { ...pi.metadata, taxCalculationId: calc.id ?? '' },
        });
        const taxLines = await this.taxLinesFromCalculation(calc);
        await this.prisma.billingOrder.update({
          where: { id: order.id },
          data: {
            taxMinor: calc.tax_amount_exclusive,
            totalMinor: calc.amount_total,
            taxCalculationId: calc.id ?? null,
            taxBreakdown: taxLines as unknown as Prisma.InputJsonValue,
          },
        });
        await billingAudit(this.prisma, 'tax.recalculated', userId, { orderId: order.id, totalMinor: calc.amount_total });
      } catch (err) {
        this.logger.warn(`tax recalculation for ${order.id} failed: ${describeStripeError(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------- trial claim

  async hasClaimed(userId: string, item: BillingItem): Promise<boolean> {
    if (!item.claimMetric) return false;
    const row = await this.prisma.usageCounter.findUnique({
      where: { userId_metric_periodKey: { userId, metric: item.claimMetric, periodKey: TRIAL_PERIOD_KEY } },
    });
    return row != null;
  }
}

/** The PaymentIntent behind an invoice's first payment, if Stripe has one. */
export function firstInvoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const payments = invoice.payments?.data ?? [];
  for (const p of payments) {
    const pi = p.payment?.payment_intent;
    if (pi) return typeof pi === 'string' ? pi : pi.id;
  }
  return null;
}

export { BILLING_CURRENCY };
