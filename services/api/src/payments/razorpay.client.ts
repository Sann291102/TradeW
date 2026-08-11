import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay, over its REST API — no SDK dependency.
 *
 * The same reasoning as `GoogleOauthService`: the surface we need is one POST
 * (create order) and two HMAC checks (verify a client callback, verify a
 * webhook). Raw `fetch` + Node `crypto` does all three in a file, versus adding
 * and tracking the `razorpay` package for the same. Every secret stays
 * server-side; the browser only ever receives the public `key_id` and an order
 * id.
 *
 * UNCONFIGURED IS A FIRST-CLASS STATE. With no `RAZORPAY_KEY_ID`/`_SECRET`,
 * `configured` is false and the payment surface reports "billing not enabled"
 * (mirroring `GET /pricing`'s `billingEnabled:false`) rather than half-working.
 * Nothing here throws at construction — the API must boot without payment creds.
 */

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

const ORDERS_ENDPOINT = 'https://api.razorpay.com/v1/orders';

@Injectable()
export class RazorpayClient {
  private readonly logger = new Logger(RazorpayClient.name);
  private readonly keyId = process.env.RAZORPAY_KEY_ID;
  private readonly keySecret = process.env.RAZORPAY_KEY_SECRET;
  /** A distinct secret Razorpay signs webhooks with — set in the dashboard. */
  private readonly webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  get configured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  /** The publishable key the browser needs to open the checkout widget. */
  get publicKeyId(): string | null {
    return this.keyId ?? null;
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new ServiceUnavailableException('Payments are not enabled on this server.');
    }
  }

  /** Create an order Razorpay's widget will collect payment against. */
  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    this.assertConfigured();
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    const res = await fetch(ORDERS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
        payment_capture: 1, // auto-capture on authorization; no manual capture step
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Razorpay order create failed: ${res.status} ${detail.slice(0, 200)}`);
      throw new ServiceUnavailableException('Could not start the payment.');
    }
    return (await res.json()) as RazorpayOrder;
  }

  /**
   * Verify the signature the checkout widget hands back to the browser.
   * Razorpay signs `${order_id}|${payment_id}` with the key secret. A valid
   * signature proves the callback came from Razorpay, not a forged client POST —
   * so fulfilment must NEVER happen without this returning true.
   */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.keySecret) return false;
    const expected = createHmac('sha256', this.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    return safeEqualHex(expected, signature);
  }

  /** Verify a webhook body against `X-Razorpay-Signature` using the webhook secret. */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!this.webhookSecret || !signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return safeEqualHex(expected, signature);
  }

  get webhookConfigured(): boolean {
    return Boolean(this.webhookSecret);
  }
}

/** Constant-time hex compare; length-checked first because timingSafeEqual throws on mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
