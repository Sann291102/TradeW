import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { api } from './api';

/**
 * Browser-side billing client. Talks only to services/api; Stripe.js is loaded
 * on demand with the PUBLISHABLE key the server hands out. The browser never
 * sees a secret key, never sends a price (only an item id), and card details
 * go straight from Stripe's own iframe (the Payment Element) to Stripe.
 *
 * Whether a payment succeeded is decided server-side from Stripe's signed
 * webhook. After Stripe.js confirms, the page polls the order until the
 * server says `paid` or `failed`.
 */

// ------------------------------------------------------------------ catalog

export interface CatalogItem {
  id: string;
  label: string;
  product: 'learning' | 'sentinel_pro';
  kind: 'recurring' | 'one_time';
  amountMinor: number;
  amountLabel: string;
  priceLabel: string;
  intervalCount: number | null;
  days: number | null;
  /** Local-currency prices chosen by billing-address country (e.g. ₹499/month for IN). */
  localPrices: Array<{ country: string; currency: string; amountMinor: number; label: string }>;
}

/** The one-time 7-day pass. Rides beside `items` for the pricing screens. */
export interface CatalogTrial {
  id: string;
  label: string;
  days: number;
  amountMinor: number;
  amountLabel: string;
  dailyRateLabel: string;
  discountPct: number;
}

export interface Catalog {
  currency: string;
  billingEnabled: boolean;
  mode: 'test' | 'live';
  publishableKey: string | null;
  items: CatalogItem[];
  trial: CatalogTrial;
  taxNote: string;
  notice?: string;
}

export interface TrialStatus {
  eligible: boolean;
  reason: 'available' | 'already_claimed' | 'already_subscribed';
}

export function fetchCatalog(): Promise<Catalog> {
  return api('/payments/catalog');
}

export function fetchTrialStatus(): Promise<TrialStatus> {
  return api('/payments/trial');
}

// ------------------------------------------------------------------ checkout

export interface TaxLine {
  label: string;
  amountMinor: number;
  ratePercent: string | null;
  taxabilityReason: string | null;
}

export interface Quote {
  itemId: string;
  label: string;
  kind: 'recurring' | 'one_time';
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxLines: TaxLine[];
  taxNote: string | null;
  billingAddressSummary: string;
}

export interface CheckoutSession {
  orderId: string;
  status: OrderStatus;
  kind: 'subscription' | 'renewal' | 'one_time';
  clientSecret: string | null;
  publishableKey: string | null;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxLines: TaxLine[];
  taxNote: string | null;
}

export type OrderStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'canceled' | 'refunded' | 'partially_refunded';

export interface Order {
  id: string;
  itemId: string;
  label: string;
  kind: 'subscription' | 'renewal' | 'one_time';
  status: OrderStatus;
  paymentStatus: string | null;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  refundedMinor: number;
  taxLines: TaxLine[];
  savePaymentMethod: boolean;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
  accessPath: string;
}

export function fetchQuote(itemId: string): Promise<Quote> {
  return api('/checkout/quote', { method: 'POST', body: JSON.stringify({ itemId }) });
}

export function createCheckout(input: {
  itemId: string;
  idempotencyKey: string;
  savePaymentMethod?: boolean;
  paymentMethodId?: string;
}): Promise<CheckoutSession> {
  return api('/checkout/create', { method: 'POST', body: JSON.stringify(input) });
}

export function confirmOrder(orderId: string): Promise<Order> {
  return api('/checkout/confirm', { method: 'POST', body: JSON.stringify({ orderId }) });
}

export function fetchOrder(orderId: string): Promise<Order> {
  return api(`/checkout/orders/${encodeURIComponent(orderId)}`);
}

export function listOrders(): Promise<{ orders: Order[] }> {
  return api('/checkout/orders');
}

export interface SubscriptionView {
  id: string;
  plan: string;
  planCode: string;
  status: string;
  provider: string;
  renews: boolean;
  cancelAtPeriodEnd: boolean;
  expiresAt: string | null;
  startedAt: string;
}

export function listSubscriptions(): Promise<{ subscriptions: SubscriptionView[] }> {
  return api('/checkout/subscriptions');
}

export function cancelSubscription(id: string): Promise<{ subscriptions: SubscriptionView[] }> {
  return api(`/checkout/subscriptions/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export function resumeSubscription(id: string): Promise<{ subscriptions: SubscriptionView[] }> {
  return api(`/checkout/subscriptions/${encodeURIComponent(id)}/resume`, { method: 'POST' });
}

// ------------------------------------------------------------------ cards

export interface Card {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  expired: boolean;
}

export function listCards(): Promise<{ cards: Card[] }> {
  return api('/payments/methods');
}

export function createSetupIntent(): Promise<{ clientSecret: string; setupIntentId: string }> {
  return api('/payments/setup-intent', { method: 'POST' });
}

export function removeCard(id: string): Promise<{ cards: Card[] }> {
  return api(`/payments/methods/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function setDefaultCard(id: string): Promise<{ cards: Card[] }> {
  return api(`/payments/methods/${encodeURIComponent(id)}/default`, { method: 'PUT' });
}

export function cardLabel(c: Pick<Card, 'brand' | 'last4'>): string {
  const brand = c.brand ? c.brand.charAt(0).toUpperCase() + c.brand.slice(1) : 'Card';
  return `${brand} ending ${c.last4}`;
}

// ------------------------------------------------------------------ profile

export interface Address {
  name: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  country: string;
}

export interface AddressView extends Address {
  kind: 'billing' | 'shipping';
  updatedAt: string;
  stripeSync: { status: 'synced' | 'pending' | 'not_configured'; syncedAt: string | null; message: string | null };
}

export interface BillingProfile {
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  billingEnabled: boolean;
  paymentProfile: 'ready' | 'retrying' | 'not_created';
  billingAddress: AddressView | null;
  shippingAddress: AddressView | null;
}

export function fetchBillingProfile(): Promise<BillingProfile> {
  return api('/customer/profile');
}

export function updateBillingProfile(input: { firstName: string; lastName: string }): Promise<BillingProfile> {
  return api('/customer/profile', { method: 'PUT', body: JSON.stringify(input) });
}

export function saveAddress(kind: 'billing' | 'shipping', address: Address): Promise<AddressView> {
  return api(`/customer/${kind}-address`, { method: 'PUT', body: JSON.stringify(address) });
}

export function deleteShippingAddress(): Promise<{ ok: true }> {
  return api('/customer/shipping-address', { method: 'DELETE' });
}

// ------------------------------------------------------------------ Stripe.js

const stripeByKey = new Map<string, Promise<Stripe | null>>();

/** Load Stripe.js once per publishable key. */
export function getStripe(publishableKey: string): Promise<Stripe | null> {
  let p = stripeByKey.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripeByKey.set(publishableKey, p);
  }
  return p;
}

/** Cents → "$12.34". */
export function money(amountMinor: number, currency = 'usd'): string {
  const inrWhole = currency.toLowerCase() === 'inr' && amountMinor % 100 === 0;
  return new Intl.NumberFormat(currency.toLowerCase() === 'inr' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...(inrWhole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(amountMinor / 100);
}

/** One UUID per checkout attempt, so a double-click cannot create two charges. */
export function newAttemptKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}
