import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notification/notification.service';
import { paymentReceipt, paymentFailed } from '../mail/templates';
import { RazorpayClient } from './razorpay.client';
import {
  CATALOG,
  catalogItem,
  toPaise,
  CATALOG_CURRENCY,
  formatInr,
  TRIAL_ITEM,
  TRIAL_PERIOD_KEY,
  type CatalogItem,
} from './payment.catalog';
import { SENTINEL_TRIAL } from '@tradew/types';

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
      // The trial rides alongside `items` rather than inside it — see TRIAL_ITEM.
      // No eligibility here: this route is public and per-account state must not
      // leak from it. Whether THIS user may still claim it is `trialStatus()`.
      trial: {
        id: TRIAL_ITEM.id,
        label: TRIAL_ITEM.label,
        days: SENTINEL_TRIAL.days,
        amountInr: TRIAL_ITEM.amountInr,
        amountLabel: formatInr(TRIAL_ITEM.amountInr),
        dailyRateLabel: formatInr(SENTINEL_TRIAL.dailyRate),
        discountPct: SENTINEL_TRIAL.discountPct,
      },
      notice: this.razorpay.configured ? undefined : 'Payments are not enabled yet. No account can be charged.',
    };
  }

  /**
   * Whether this account may still claim the one-time trial. Authenticated —
   * this is per-user state and deliberately absent from the public catalog.
   */
  async trialStatus(userId: string): Promise<{ eligible: boolean; reason: 'available' | 'already_claimed' | 'already_subscribed' }> {
    if (await this.hasClaimed(userId, TRIAL_ITEM)) {
      return { eligible: false, reason: 'already_claimed' };
    }
    // Someone already holding Sentinel has nothing to trial. Selling it to them
    // would charge for access they already have.
    const decision = await this.entitlements.check(userId, 'sentinel');
    if (decision.allowed) return { eligible: false, reason: 'already_subscribed' };
    return { eligible: true, reason: 'available' };
  }

  /**
   * Start a checkout: create a Razorpay order the widget will collect against.
   * Returns everything the browser needs to open the widget, and nothing secret.
   */
  async createCheckout(userId: string, itemId: string) {
    const item = catalogItem(itemId);
    if (!item) throw new BadRequestException('Unknown item');
    if (!this.razorpay.configured) throw new BadRequestException('Payments are not enabled on this server.');

    // Refuse a second claim BEFORE an order exists, so a one-time offer is
    // declined without money moving. `fulfil` re-checks — this is the courteous
    // gate, that one is the authoritative one.
    if (item.oncePerUser && (await this.hasClaimed(userId, item))) {
      throw new BadRequestException('You have already used your one-time trial.');
    }

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

    // Consume the one-time claim FIRST. The unique constraint on
    // (userId, metric, periodKey) is the lock: two checkouts racing past the
    // createCheckout gate both reach here, and exactly one create survives.
    if (item.oncePerUser) {
      const claimed = await this.claim(userId, item);
      if (!claimed) {
        // Money was taken for a trial this account already holds. Refusing to
        // grant a second one is correct, but it must not be silent — this is a
        // refund an operator has to make by hand.
        this.logger.error(
          `DUPLICATE one-time claim: payment ${paymentId} (user ${userId}, item ${item.id}) charged but NOT granted — refund required`,
        );
        return;
      }
    }

    const now = new Date();
    // A day-length term is granted as a real trial: TRIALING status, so
    // `EntitlementsService.check` reports reason 'trial' rather than passing it
    // off as a purchased month.
    const isDayTerm = typeof item.days === 'number';
    const expiresAt = isDayTerm ? addDays(now, item.days!) : addMonths(now, item.months);
    const sub = await this.entitlements.activate(userId, item.planCode, {
      trial: isDayTerm,
      expiresAt,
    });
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        billingProvider: 'razorpay',
        billingReference: paymentId,
        // `activate` derives trialEndsAt from `Plan.trialDays`, a seed value.
        // The term the user PAID for is `item.days`, so it is restated here:
        // editing the seed must never silently change what a charge buys.
        ...(isDayTerm ? { trialEndsAt: expiresAt } : {}),
      },
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

  /** Has this account already consumed `item`'s one-time claim? */
  private async hasClaimed(userId: string, item: CatalogItem): Promise<boolean> {
    if (!item.claimMetric) return false;
    const row = await this.prisma.usageCounter.findUnique({
      where: { userId_metric_periodKey: { userId, metric: item.claimMetric, periodKey: TRIAL_PERIOD_KEY } },
    });
    return row != null;
  }

  /**
   * Consume the one-time claim. Returns false if it was already taken.
   *
   * Deliberately `create`, never `upsert`: the unique constraint failing IS the
   * answer, and it is the only check here that two concurrent requests cannot
   * both pass.
   */
  private async claim(userId: string, item: CatalogItem): Promise<boolean> {
    if (!item.claimMetric) return true;
    try {
      await this.prisma.usageCounter.create({
        data: { userId, metric: item.claimMetric, periodKey: TRIAL_PERIOD_KEY, used: 1 },
      });
      return true;
    } catch {
      return false;
    }
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

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86400_000);
}

function nowLabel(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
}
