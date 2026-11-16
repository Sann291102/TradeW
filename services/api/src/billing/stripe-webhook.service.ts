import { BadRequestException, Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe = require('stripe');
import { PrismaService } from '../prisma/prisma.service';
import { StripeGateway } from './stripe.gateway';
import { StripeCustomerService } from './stripe-customer.service';
import { PaymentMethodsService } from './payment-methods.service';
import { BillingFulfilmentService } from './billing-fulfilment.service';
import { describeStripeError } from './stripe-errors';

/** The events this endpoint acts on. Anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = [
  'customer.created',
  'customer.updated',
  'payment_intent.created',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_method.attached',
  'payment_method.detached',
  'setup_intent.succeeded',
  'charge.refunded',
  // Recurring billing: first payment and renewals, failures, cancellations.
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

/**
 * `POST /stripe/webhook` (browser path `/api/stripe/webhook`).
 *
 *  1. The signature is verified with `constructEvent` over the RAW request
 *     bytes (Nest boots with `rawBody: true`). A parsed-then-reserialised body
 *     would not match the signature, so nothing else is accepted.
 *  2. The event id is stored in `StripeWebhookEvent` (unique). A delivery whose
 *     id is already `processed` or `ignored` is acknowledged without being run
 *     again. A `failed` one is run again: that is how Stripe's retries (and an
 *     operator's "resend") recover from a handler error.
 *  3. A handler error marks the row `failed` with a sanitised message and
 *     answers 500, so Stripe retries with backoff for up to three days.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StripeGateway,
    private readonly customers: StripeCustomerService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly fulfilment: BillingFulfilmentService,
  ) {}

  verify(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
    const secret = this.gateway.webhookSecret;
    if (!this.gateway.enabled || !secret) throw new ServiceUnavailableException('Stripe webhooks are not configured.');
    if (!rawBody || !signature) throw new BadRequestException('Missing Stripe signature.');
    try {
      return this.gateway.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      this.logger.warn(`rejected webhook: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException('Invalid Stripe signature.');
    }
  }

  async handle(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ received: true; duplicate?: true; ignored?: true }> {
    const event = this.verify(rawBody, signature);

    // An event from the other mode (a live event reaching a test server, or
    // the reverse) is a misconfigured endpoint, never something to act on.
    if (event.livemode !== (this.gateway.mode === 'live')) {
      this.logger.warn(`ignored ${event.livemode ? 'live' : 'test'} event ${event.id} on a ${this.gateway.mode} server`);
      return { received: true, ignored: true };
    }

    const handled = (HANDLED_EVENTS as readonly string[]).includes(event.type);
    let row = await this.prisma.stripeWebhookEvent.findUnique({ where: { eventId: event.id } });
    if (row && (row.status === 'processed' || row.status === 'ignored')) return { received: true, duplicate: true };
    if (!row) {
      try {
        row = await this.prisma.stripeWebhookEvent.create({
          data: { eventId: event.id, type: event.type, livemode: event.livemode, status: handled ? 'received' : 'ignored' },
        });
      } catch {
        // Two deliveries of one event racing: the loser treats it as duplicate.
        return { received: true, duplicate: true };
      }
    }
    if (!handled) return { received: true, ignored: true };

    await this.prisma.stripeWebhookEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    try {
      await this.dispatch(event);
      await this.prisma.stripeWebhookEvent.update({
        where: { id: row.id },
        data: { status: 'processed', processedAt: new Date(), lastError: null },
      });
      return { received: true };
    } catch (err) {
      const reason = describeStripeError(err).slice(0, 500);
      this.logger.error(`webhook ${event.type} ${event.id} failed: ${reason}`);
      await this.prisma.stripeWebhookEvent.update({ where: { id: row.id }, data: { status: 'failed', lastError: reason } });
      throw new InternalServerErrorException('Webhook handler failed; Stripe will retry.');
    }
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.created':
      case 'customer.updated':
        return this.customers.linkFromWebhook(event.data.object);
      case 'payment_intent.created':
        return this.fulfilment.onPaymentIntentCreated(event.data.object);
      case 'payment_intent.succeeded':
        return this.fulfilment.onPaymentIntentSucceeded(event.data.object);
      case 'payment_intent.payment_failed':
        return this.fulfilment.onPaymentIntentFailed(event.data.object);
      case 'payment_intent.canceled':
        return this.fulfilment.onPaymentIntentCanceled(event.data.object);
      case 'payment_method.attached':
        return this.paymentMethods.onAttached(event.data.object);
      case 'payment_method.detached':
        return this.paymentMethods.onDetached(event.data.object);
      case 'setup_intent.succeeded':
        return this.paymentMethods.onSetupIntentSucceeded(event.data.object);
      case 'charge.refunded':
        return this.fulfilment.onChargeRefunded(event.data.object);
      case 'invoice.paid':
        return this.fulfilment.onInvoicePaid(event.data.object);
      case 'invoice.payment_failed':
        return this.fulfilment.onInvoicePaymentFailed(event.data.object);
      case 'customer.subscription.updated':
        return this.fulfilment.onSubscriptionUpdated(event.data.object);
      case 'customer.subscription.deleted':
        return this.fulfilment.onSubscriptionDeleted(event.data.object);
      default:
        return;
    }
  }
}
