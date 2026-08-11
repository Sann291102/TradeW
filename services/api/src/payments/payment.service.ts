import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notification/notification.service';
import { paymentReceipt, paymentFailed } from '../mail/templates';
import { RazorpayClient } from './razorpay.client';
import { CATALOG, catalogItem, toPaise, CATALOG_CURRENCY, formatInr, type CatalogItem } from './payment.catalog';

/**
 * Payment orchestration — the ONLY thing that turns a Razorpay success into a
 * subscription. It never decides entitlement itself: fulfilment goes through
 * `EntitlementsService.activate`, the one sanctioned lifecycle seam (see that
 * service's "future billing adapters drive state exclusively through these
 * methods" note).
 *
 * TRUST MODEL
 *  · The browser is never trusted to say "I paid." Both fulfilment paths
 *    (the widget callback `verifyCheckout` and the server-to-server `webhook`)
 *    require a valid Razorpay HMAC signature before anything is granted.
 *  · Fulfilment is IDEMPOTENT on the Razorpay payment id: the callback and the
 *    webhook routinely both fire for one payment, and a user can double-submit.
 *    A payment id that already backs a subscription is a no-op, so no one is
 *    ever granted two terms for one charge.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
    private readonly razorpay: RazorpayClient,
  ) {}

  /** The public catalog + whether this deployment can actually charge. */
  catalog() {
    return {
      currency: CATALOG_CURRENCY,
      billingEnabled: this.razorpay.configured,
      keyId: this.razorpay.publicKeyId,
      items: CATALOG.map((i) => ({ id: i.id, label: i.label, months: i.months, amountInr: i.amountInr, amountLabel: formatInr(i.amountInr) })),
      notice: this.razorpay.configured ? undefined : 'Payments are not enabled yet. No account can be charged.',
    };
  }

  /**
   * Start a checkout: create a Razorpay order the widget will collect against.
   * Returns everything the browser needs to open the widget, and nothing secret.
   */
  async createCheckout(userId: string, itemId: string) {
    const item = catalogItem(itemId);
    if (!item) throw new BadRequestException('Unknown item');
    if (!this.razorpay.configured) throw new BadRequestException('Payments are not enabled on this server.');

    const order = await this.razorpay.createOrder({
      amountPaise: toPaise(item.amountInr),
      currency: CATALOG_CURRENCY,
      receipt: `${itemId}:${userId}`.slice(0, 40),
      notes: { userId, itemId },
    });

    return {
      provider: 'razorpay' as const,
      keyId: this.razorpay.publicKeyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      item: { id: item.id, label: item.label, amountLabel: formatInr(item.amountInr) },
    };
  }

  /**
   * Verify the widget callback and fulfil. Called from the browser right after
   * the widget reports success — but it is the SIGNATURE, not the browser, that
   * is trusted. On a bad signature nothing is granted and the caller is told
   * plainly.
   */
  async verifyCheckout(
    userId: string,
    body: { itemId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string },
  ) {
    const item = catalogItem(body.itemId);
    if (!item) throw new BadRequestException('Unknown item');

    const ok = this.razorpay.verifyPaymentSignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature);
    if (!ok) {
      await this.onFailure(userId, item, 'Signature verification failed');
      throw new BadRequestException('Payment could not be verified.');
    }

    await this.fulfil(userId, item, body.razorpayPaymentId);
    return { ok: true, activated: true };
  }

  /**
   * Server-to-server webhook — the authoritative fulfilment path. Razorpay
   * retries this until it gets a 2xx, so it must be idempotent (it is) and must
   * verify the webhook signature over the RAW body.
   */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ ok: true }> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw new BadRequestException('Invalid webhook signature');
    }
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException('Malformed webhook body');
    }

    const type = event?.event as string | undefined;
    const entity = event?.payload?.payment?.entity ?? event?.payload?.order?.entity;
    const notes = entity?.notes ?? {};
    const userId = notes.userId as string | undefined;
    const itemId = notes.itemId as string | undefined;
    const paymentId = (event?.payload?.payment?.entity?.id as string | undefined) ?? entity?.id;

    if (!userId || !itemId || !paymentId) {
      // A webhook we don't have enough context to act on — acknowledge so
      // Razorpay stops retrying, but do nothing.
      this.logger.warn(`webhook ${type} missing userId/itemId/paymentId in notes; ignored`);
      return { ok: true };
    }
    const item = catalogItem(itemId);
    if (!item) return { ok: true };

    if (type === 'payment.captured' || type === 'order.paid') {
      await this.fulfil(userId, item, paymentId);
    } else if (type === 'payment.failed') {
      await this.onFailure(userId, item, entity?.error_description || 'Payment failed');
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ internal

  /** Idempotently activate the plan, then send the receipt + raise a notification. */
  private async fulfil(userId: string, item: CatalogItem, paymentId: string): Promise<void> {
    const already = await this.prisma.subscription.findFirst({ where: { billingReference: paymentId } });
    if (already) return; // this payment has already been fulfilled

    const expiresAt = addMonths(new Date(), item.months);
    const sub = await this.entitlements.activate(userId, item.planCode, { expiresAt });
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { billingProvider: 'razorpay', billingReference: paymentId },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const when = nowLabel();
    const activeUntil = expiresAt.toLocaleDateString('en-IN', { dateStyle: 'medium' } as Intl.DateTimeFormatOptions);

    if (user?.email && !user.email.endsWith('@phone.tradew.local')) {
      const mail = paymentReceipt({
        email: user.email,
        itemLabel: item.label,
        amountLabel: formatInr(item.amountInr),
        paymentId,
        when,
        activeUntil,
      });
      void this.mail.send(user.email, mail.subject, mail.text, mail.html).catch(() => undefined);
    }
    await this.notifications
      .create(userId, { category: 'announcement', title: 'Payment successful', body: `${item.label} is now active until ${activeUntil}.` })
      .catch(() => undefined);
  }

  /** Notify + email on a failed/could-not-verify payment. Never throws. */
  private async onFailure(userId: string, item: CatalogItem, reason: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null);
    if (user?.email && !user.email.endsWith('@phone.tradew.local')) {
      const mail = paymentFailed({ email: user.email, itemLabel: item.label, amountLabel: formatInr(item.amountInr), when: nowLabel(), reason });
      void this.mail.send(user.email, mail.subject, mail.text, mail.html).catch(() => undefined);
    }
    await this.notifications
      .create(userId, { category: 'announcement', title: 'Payment not completed', body: `Your payment for ${item.label} didn't go through. Nothing was charged.` })
      .catch(() => undefined);
  }
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

function nowLabel(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
}
