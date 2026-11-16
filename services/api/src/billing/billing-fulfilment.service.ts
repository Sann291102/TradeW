import { Injectable, Logger } from '@nestjs/common';
import type { BillingOrder } from '@prisma/client';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EmailService } from '../mail/email.service';
import { NotificationService } from '../notification/notification.service';
import { StripeGateway } from './stripe.gateway';
import { StripeCustomerService } from './stripe-customer.service';
import { billingItem, formatMinor, TRIAL_PERIOD_KEY, type BillingItem } from './billing.catalog';
import { firstInvoicePaymentIntentId } from './checkout.service';
import { cardLabel } from './payment-methods.service';
import { billingAudit } from './billing-audit';
import { describeStripeError } from './stripe-errors';

function dateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'medium' });
}
function dateTimeLabel(d: Date): string {
  return d.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
}
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86400_000);
}
function idOf(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === 'string' ? x : x.id;
}

/**
 * Turns VERIFIED Stripe events into TradeW state: orders marked paid or
 * failed, entitlements activated, renewed, past-due or ended, receipts sent.
 *
 * Everything here is reached only from the signature-verified webhook. The
 * browser saying "it worked" never grants anything.
 *
 * Idempotency is layered: the webhook stores each event id once, and each
 * transition here is also a conditional update (`status != paid`), so even a
 * replayed or out-of-order event cannot grant twice or email twice.
 */
@Injectable()
export class BillingFulfilmentService {
  private readonly logger = new Logger(BillingFulfilmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StripeGateway,
    private readonly entitlements: EntitlementsService,
    private readonly email: EmailService,
    private readonly notifications: NotificationService,
    private readonly customers: StripeCustomerService,
  ) {}

  private async userContact(userId: string) {
    return this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true } });
  }

  private async cardLabelForPaymentIntent(piId: string | null): Promise<string> {
    if (!piId) return 'Card';
    try {
      const pi = await this.gateway.stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] });
      const pm = pi.payment_method as Stripe.PaymentMethod | null;
      return pm?.card ? cardLabel(pm.card.brand, pm.card.last4) : 'Card';
    } catch {
      return 'Card';
    }
  }

  /** Atomically move an order to paid. Returns false when it already was. */
  private async markPaid(orderId: string, data: Partial<BillingOrder>): Promise<boolean> {
    const res = await this.prisma.billingOrder.updateMany({
      where: { id: orderId, status: { notIn: ['paid', 'refunded', 'partially_refunded'] } },
      data: { ...data, status: 'paid', paidAt: new Date() } as never,
    });
    return res.count === 1;
  }

  private async recordCharge(orderId: string, objectId: string, amountMinor: number, currency: string) {
    await this.prisma.billingTransaction
      .create({ data: { orderId, type: 'charge', stripeObjectId: objectId, amountMinor, currency, status: 'succeeded' } })
      .catch(() => undefined); // unique on objectId: a replay is a no-op
  }

  private async sendPaidEmails(order: BillingOrder, item: BillingItem, accessUntil: Date, piId: string | null, renewal: boolean) {
    const user = await this.userContact(order.userId);
    if (!user) return;
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const vars = {
      FirstName: user.firstName || 'there',
      OrderId: order.id,
      ItemName: item.label,
      Subtotal: formatMinor(order.subtotalMinor, order.currency),
      Tax: formatMinor(order.taxMinor, order.currency),
      Total: formatMinor(order.totalMinor, order.currency),
      PaidAt: dateTimeLabel(new Date()),
      CardLabel: await this.cardLabelForPaymentIntent(piId),
      AccessUntil: dateLabel(accessUntil),
      AccessUrl: `${base}${item.accessPath}`,
    };
    if (renewal) this.email.dispatch('payment_successful', user.email, vars, { userId: order.userId });
    else this.email.dispatch('order_confirmation', user.email, vars, { userId: order.userId });
    this.email.dispatch('order_receipt', user.email, vars, { userId: order.userId });
    await this.notifications
      .create(order.userId, {
        category: 'announcement',
        title: renewal ? 'Subscription renewed' : 'Payment successful',
        body: `${item.label} is active until ${dateLabel(accessUntil)}.`,
      })
      .catch(() => undefined);
  }

  private async sendFailedEmail(order: BillingOrder, item: BillingItem, reason: string) {
    const user = await this.userContact(order.userId);
    this.email.dispatch(
      'payment_failed',
      user?.email,
      { ItemName: item.label, Total: formatMinor(order.totalMinor, order.currency), Reason: reason },
      { userId: order.userId },
    );
    await this.notifications
      .create(order.userId, { category: 'announcement', title: 'Payment not completed', body: `Your payment for ${item.label} didn't go through.` })
      .catch(() => undefined);
  }

  // ================================================================ one-time

  private async orderForPaymentIntent(pi: Stripe.PaymentIntent): Promise<BillingOrder | null> {
    const byPi = await this.prisma.billingOrder.findUnique({ where: { stripePaymentIntentId: pi.id } });
    if (byPi) return byPi;
    const orderId = pi.metadata?.orderId;
    return orderId ? this.prisma.billingOrder.findUnique({ where: { id: orderId } }) : null;
  }

  async onPaymentIntentCreated(pi: Stripe.PaymentIntent) {
    const order = await this.orderForPaymentIntent(pi);
    if (order && order.status === 'pending') {
      await this.prisma.billingOrder.update({ where: { id: order.id }, data: { paymentStatus: pi.status } });
    }
  }

  async onPaymentIntentSucceeded(pi: Stripe.PaymentIntent) {
    const order = await this.orderForPaymentIntent(pi);
    // Subscription invoices are fulfilled from `invoice.paid`, which carries
    // the billing period. Only one-time orders are fulfilled here.
    if (!order || order.kind !== 'one_time') return;
    const item = billingItem(order.itemId);
    if (!item) return;

    // Stripe's amount is authoritative for what was charged; refuse to grant
    // if it disagrees with the server-computed total.
    if (pi.amount_received !== order.totalMinor || pi.currency !== order.currency) {
      this.logger.error(`AMOUNT MISMATCH on ${order.id}: charged ${pi.amount_received} ${pi.currency}, expected ${order.totalMinor} ${order.currency}`);
      await this.prisma.billingOrder.update({ where: { id: order.id }, data: { failureReason: 'Amount mismatch; held for review' } });
      await billingAudit(this.prisma, 'order.amount_mismatch', order.userId, { orderId: order.id, piId: pi.id });
      return;
    }

    if (!(await this.markPaid(order.id, { paymentStatus: pi.status, stripePaymentIntentId: pi.id }))) return;
    await this.recordCharge(order.id, idOf(pi.latest_charge) ?? pi.id, pi.amount_received, pi.currency);

    if (item.oncePerUser && item.claimMetric) {
      const claimed = await this.prisma.usageCounter
        .create({ data: { userId: order.userId, metric: item.claimMetric, periodKey: TRIAL_PERIOD_KEY, used: 1 } })
        .then(() => true)
        .catch(() => false);
      if (!claimed) {
        this.logger.error(`DUPLICATE one-time claim: order ${order.id} paid but NOT granted; refund required`);
        await billingAudit(this.prisma, 'order.duplicate_claim', order.userId, { orderId: order.id });
        return;
      }
    }

    const expiresAt = addDays(new Date(), item.days ?? 0);
    const sub = await this.entitlements.activate(order.userId, item.planCode, { trial: true, expiresAt });
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { billingProvider: 'stripe', billingReference: pi.id, trialEndsAt: expiresAt },
    });
    await this.prisma.billingOrder.update({ where: { id: order.id }, data: { subscriptionId: sub.id } });

    // Record the sale with Stripe Tax so it appears in tax reports.
    const calcId = order.taxCalculationId || pi.metadata?.taxCalculationId;
    if (calcId) {
      try {
        const tx = await this.gateway.stripe.tax.transactions.createFromCalculation(
          { calculation: calcId, reference: order.id, metadata: { orderId: order.id } },
          { idempotencyKey: `tradew-taxtx-${order.id}` },
        );
        await this.prisma.billingOrder.update({ where: { id: order.id }, data: { taxTransactionId: tx.id } });
      } catch (err) {
        this.logger.warn(`tax transaction for ${order.id} failed: ${describeStripeError(err)}`);
      }
    }

    // Saved with consent: let it be offered again in future checkouts.
    const pmId = idOf(pi.payment_method);
    if (order.savePaymentMethod && pmId) {
      await this.gateway.stripe.paymentMethods.update(pmId, { allow_redisplay: 'always' }).catch(() => undefined);
    }

    await billingAudit(this.prisma, 'order.paid', order.userId, { orderId: order.id, piId: pi.id, totalMinor: order.totalMinor });
    await this.sendPaidEmails(order, item, expiresAt, pi.id, false);
  }

  async onPaymentIntentFailed(pi: Stripe.PaymentIntent) {
    const order = await this.orderForPaymentIntent(pi);
    if (!order || order.kind !== 'one_time' || order.status === 'paid') return;
    const item = billingItem(order.itemId);
    const reason = pi.last_payment_error?.message || 'The payment was declined.';
    await this.prisma.billingOrder.update({
      where: { id: order.id },
      data: { status: 'failed', paymentStatus: pi.status, failureReason: reason.slice(0, 300) },
    });
    await billingAudit(this.prisma, 'order.failed', order.userId, { orderId: order.id, code: pi.last_payment_error?.code });
    if (item) await this.sendFailedEmail(order, item, reason);
  }

  async onPaymentIntentCanceled(pi: Stripe.PaymentIntent) {
    const order = await this.orderForPaymentIntent(pi);
    if (!order || order.status === 'paid') return;
    await this.prisma.billingOrder.update({ where: { id: order.id }, data: { status: 'canceled', paymentStatus: pi.status } });
    await billingAudit(this.prisma, 'order.canceled', order.userId, { orderId: order.id });
  }

  // ================================================================ subscriptions

  private subscriptionIdOf(invoice: Stripe.Invoice): string | null {
    return idOf(invoice.parent?.subscription_details?.subscription ?? null);
  }

  /**
   * Webhook payloads do not include `invoice.payments` (it is an expandable
   * list), so the PaymentIntent behind the invoice is read from a fresh,
   * expanded retrieve rather than from the event body.
   */
  private async expandedInvoice(invoice: Stripe.Invoice): Promise<Stripe.Invoice> {
    if (!invoice.id) return invoice;
    return this.gateway.stripe.invoices.retrieve(invoice.id, { expand: ['payments'] });
  }

  async onInvoicePaid(eventInvoice: Stripe.Invoice) {
    const subId = this.subscriptionIdOf(eventInvoice);
    if (!subId || !eventInvoice.id) return;
    const invoice = await this.expandedInvoice(eventInvoice);
    const stripeSub = await this.gateway.stripe.subscriptions.retrieve(subId);
    const userId =
      stripeSub.metadata?.userId || (await this.customers.userIdForCustomer(idOf(stripeSub.customer)));
    const item = billingItem(stripeSub.metadata?.itemId ?? '');
    if (!userId || !item) {
      this.logger.warn(`invoice.paid ${invoice.id}: subscription ${subId} is not a TradeW checkout; ignored`);
      return;
    }

    const periodEnd = new Date(Math.max(...stripeSub.items.data.map((i) => i.current_period_end)) * 1000);
    const piId = firstInvoicePaymentIntentId(invoice);
    const taxMinor = (invoice.total_taxes ?? []).reduce((s, t) => s + t.amount, 0);
    const isFirst = invoice.billing_reason === 'subscription_create';

    let order =
      (await this.prisma.billingOrder.findUnique({ where: { stripeInvoiceId: invoice.id } })) ??
      (isFirst && stripeSub.metadata?.orderId
        ? await this.prisma.billingOrder.findUnique({ where: { id: stripeSub.metadata.orderId } })
        : null);
    if (!order) {
      // A renewal: Stripe created this invoice on its own schedule.
      order = await this.prisma.billingOrder.upsert({
        where: { idempotencyKey: `invoice:${invoice.id}` },
        create: {
          userId,
          itemId: item.id,
          kind: 'renewal',
          currency: invoice.currency,
          subtotalMinor: invoice.subtotal,
          taxMinor,
          totalMinor: invoice.total,
          idempotencyKey: `invoice:${invoice.id}`,
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subId,
          stripePaymentIntentId: piId,
          savePaymentMethod: true,
        },
        update: {},
      });
    }

    const paid = await this.markPaid(order.id, {
      paymentStatus: invoice.status ?? 'paid',
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subId,
      ...(piId ? { stripePaymentIntentId: piId } : {}),
      subtotalMinor: invoice.subtotal,
      taxMinor,
      totalMinor: invoice.total,
    });
    if (!paid) return;
    await this.recordCharge(order.id, piId ?? invoice.id, invoice.amount_paid, invoice.currency);

    // Entitlement: one Subscription row per Stripe subscription, extended on
    // each paid invoice to the end of the period it paid for.
    const existing = await this.prisma.subscription.findFirst({ where: { billingProvider: 'stripe', billingReference: subId } });
    let entitlementId: string;
    if (existing) {
      await this.entitlements.renew(existing.id, periodEnd);
      entitlementId = existing.id;
    } else {
      const created = await this.entitlements.activate(userId, item.planCode, { expiresAt: periodEnd });
      await this.prisma.subscription.update({
        where: { id: created.id },
        data: {
          billingProvider: 'stripe',
          billingReference: subId,
          stripePriceId: stripeSub.items.data[0]?.price.id ?? null,
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        },
      });
      entitlementId = created.id;
    }
    await this.prisma.billingOrder.update({ where: { id: order.id }, data: { subscriptionId: entitlementId } });
    await billingAudit(this.prisma, isFirst ? 'subscription.started' : 'subscription.renewed', userId, {
      orderId: order.id,
      invoiceId: invoice.id,
      subscriptionId: subId,
      totalMinor: invoice.total,
    });
    const fresh = await this.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
    await this.sendPaidEmails(fresh, item, periodEnd, piId, !isFirst);
  }

  async onInvoicePaymentFailed(eventInvoice: Stripe.Invoice) {
    const subId = this.subscriptionIdOf(eventInvoice);
    if (!subId || !eventInvoice.id) return;
    const invoice = await this.expandedInvoice(eventInvoice);
    const stripeSub = await this.gateway.stripe.subscriptions.retrieve(subId);
    const item = billingItem(stripeSub.metadata?.itemId ?? '');
    const userId = stripeSub.metadata?.userId || (await this.customers.userIdForCustomer(idOf(stripeSub.customer)));
    if (!item || !userId) return;
    const order =
      (await this.prisma.billingOrder.findUnique({ where: { stripeInvoiceId: invoice.id } })) ??
      (await this.prisma.billingOrder.upsert({
        where: { idempotencyKey: `invoice:${invoice.id}` },
        create: {
          userId,
          itemId: item.id,
          kind: 'renewal',
          currency: invoice.currency,
          subtotalMinor: invoice.subtotal,
          totalMinor: invoice.total,
          idempotencyKey: `invoice:${invoice.id}`,
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subId,
        },
        update: {},
      }));
    if (order.status === 'paid' || order.status === 'failed') return;
    await this.prisma.billingOrder.update({
      where: { id: order.id },
      data: { status: 'failed', paymentStatus: invoice.status ?? 'open', failureReason: 'The card was declined or needs authentication.' },
    });
    const ent = await this.prisma.subscription.findFirst({ where: { billingProvider: 'stripe', billingReference: subId } });
    if (ent) await this.entitlements.markPastDue(ent.id);
    await billingAudit(this.prisma, 'invoice.payment_failed', userId, { invoiceId: invoice.id, subscriptionId: subId });
    await this.sendFailedEmail(order, item, 'The card was declined or needs authentication.');
  }

  async onSubscriptionUpdated(sub: Stripe.Subscription) {
    const ent = await this.prisma.subscription.findFirst({ where: { billingProvider: 'stripe', billingReference: sub.id } });
    if (!ent) return;
    await this.prisma.subscription.update({
      where: { id: ent.id },
      data: {
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.cancel_at_period_end ? ent.canceledAt ?? new Date() : null,
        stripePriceId: sub.items.data[0]?.price.id ?? ent.stripePriceId,
        ...(sub.status === 'past_due' || sub.status === 'unpaid' ? { status: 'PAST_DUE' } : {}),
        ...(sub.status === 'active' && ent.status === 'PAST_DUE' ? { status: 'ACTIVE' } : {}),
      },
    });
  }

  async onSubscriptionDeleted(sub: Stripe.Subscription) {
    const ent = await this.prisma.subscription.findFirst({ where: { billingProvider: 'stripe', billingReference: sub.id } });
    if (!ent) return;
    await this.prisma.subscription.update({
      where: { id: ent.id },
      data: { status: 'CANCELED', canceledAt: ent.canceledAt ?? new Date(), expiresAt: new Date(), cancelAtPeriodEnd: false },
    });
    await billingAudit(this.prisma, 'subscription.ended', ent.userId, { subscriptionId: sub.id });
  }

  // ================================================================ refunds

  async onChargeRefunded(charge: Stripe.Charge) {
    const piId = idOf(charge.payment_intent);
    if (!piId) return;
    const order = await this.prisma.billingOrder.findUnique({ where: { stripePaymentIntentId: piId } });
    if (!order) return;
    const item = billingItem(order.itemId);
    const refunded = charge.amount_refunded;
    if (refunded <= order.refundedMinor) return; // already recorded
    const delta = refunded - order.refundedMinor;
    const full = refunded >= charge.amount;

    await this.prisma.billingTransaction
      .create({
        data: { orderId: order.id, type: 'refund', stripeObjectId: `${charge.id}:refunded:${refunded}`, amountMinor: delta, currency: charge.currency, status: 'succeeded' },
      })
      .catch(() => undefined);
    await this.prisma.billingOrder.update({
      where: { id: order.id },
      data: { refundedMinor: refunded, status: full ? 'refunded' : 'partially_refunded' },
    });

    // A full refund takes back what that payment bought.
    let accessNote = 'Your access is unchanged.';
    if (full && order.subscriptionId) {
      const ent = await this.prisma.subscription.findUnique({ where: { id: order.subscriptionId } });
      if (ent) {
        await this.prisma.subscription.update({ where: { id: ent.id }, data: { status: 'CANCELED', canceledAt: new Date(), expiresAt: new Date() } });
        if (ent.billingReference?.startsWith('sub_')) {
          await this.gateway.stripe.subscriptions.cancel(ent.billingReference).catch((e) =>
            this.logger.warn(`cancel after refund failed for ${ent.billingReference}: ${describeStripeError(e)}`),
          );
        }
        accessNote = 'Access bought with this payment has ended, and the subscription will not renew.';
      }
    }
    await billingAudit(this.prisma, full ? 'order.refunded' : 'order.partially_refunded', order.userId, { orderId: order.id, refundedMinor: refunded });
    const user = await this.userContact(order.userId);
    this.email.dispatch(
      'refund_confirmation',
      user?.email,
      {
        RefundAmount: formatMinor(delta, charge.currency),
        ItemName: item?.label ?? order.itemId,
        OrderId: order.id,
        AccessNote: accessNote,
      },
      { userId: order.userId },
    );
  }
}
