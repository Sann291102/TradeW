import { api } from './api';

/**
 * Browser-side payment client. Talks only to services/api `/payments/*`; the
 * Razorpay widget is loaded on demand and handed an order the SERVER created —
 * the browser never sees a secret key, only the publishable `keyId` and an
 * order id, and fulfilment is decided server-side by signature.
 */

export interface CatalogItem {
  id: string;
  label: string;
  months: number;
  amountInr: number;
  amountLabel: string;
}

/**
 * The one-time paid trial. Sits beside `items` rather than inside it because it
 * is granted in days, not months — see TRIAL_ITEM in the API's payment.catalog.
 */
export interface CatalogTrial {
  id: string;
  label: string;
  days: number;
  amountInr: number;
  amountLabel: string;
  dailyRateLabel: string;
  discountPct: number;
}

export interface Catalog {
  currency: string;
  billingEnabled: boolean;
  keyId: string | null;
  items: CatalogItem[];
  trial: CatalogTrial;
  notice?: string;
}

export interface TrialStatus {
  eligible: boolean;
  reason: 'available' | 'already_claimed' | 'already_subscribed';
}

/** Per-account trial eligibility. Authed — absent from the public catalog. */
export function fetchTrialStatus(): Promise<TrialStatus> {
  return api('/payments/trial');
}

export interface CheckoutOrder {
  provider: 'razorpay';
  keyId: string | null;
  orderId: string;
  amount: number;
  currency: string;
  item: { id: string; label: string; amountLabel: string };
}

export function fetchCatalog(): Promise<Catalog> {
  return api('/payments/catalog');
}

export function startCheckout(itemId: string): Promise<CheckoutOrder> {
  return api('/payments/checkout', { method: 'POST', body: JSON.stringify({ itemId }) });
}

export function verifyPayment(input: {
  itemId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<{ ok: boolean; activated: boolean }> {
  return api('/payments/verify', { method: 'POST', body: JSON.stringify(input) });
}

/** Minimal shape of the fields the Razorpay widget hands back on success. */
export interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

const RZP_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise: Promise<boolean> | null = null;

/** Load checkout.js once; resolves false if it can't load (offline / blocked). */
export function loadRazorpay(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if ((window as unknown as { Razorpay?: unknown }).Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const el = document.createElement('script');
    el.src = RZP_SRC;
    el.onload = () => resolve(true);
    el.onerror = () => {
      scriptPromise = null; // allow a retry on a later click
      resolve(false);
    };
    document.body.appendChild(el);
  });
  return scriptPromise;
}

/** Open the Razorpay modal for a server-created order. Resolves with the
 *  success payload, or null if the user dismissed it. */
export function openRazorpay(order: CheckoutOrder, prefill: { email?: string }): Promise<RazorpaySuccess | null> {
  return new Promise((resolve) => {
    const Ctor = (window as unknown as { Razorpay?: new (opts: unknown) => { open(): void } }).Razorpay;
    if (!Ctor) {
      resolve(null);
      return;
    }
    const rzp = new Ctor({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: 'TradeW · Setup',
      description: order.item.label,
      prefill: { email: prefill.email },
      theme: { color: '#0f9e8e' },
      handler: (resp: RazorpaySuccess) => resolve(resp),
      modal: { ondismiss: () => resolve(null) },
    });
    rzp.open();
  });
}
