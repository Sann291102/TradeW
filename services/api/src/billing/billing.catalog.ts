import { LEARNING_MONTHLY, SENTINEL_TERMS, SENTINEL_TRIAL, usd } from '@tradew/types';

/**
 * What TradeW sells through Stripe, and what each purchase grants.
 *
 * Prices come from `@tradew/types/pricing` (US cents), the single source of
 * truth both the UI and this catalog read, so what is displayed and what is
 * charged cannot drift. The Stripe Price behind each recurring item is found
 * by `lookupKey` and its amount is checked against this catalog before every
 * charge (`StripePriceService`): a Dashboard edit that disagrees with the code
 * fails closed instead of charging an amount nobody displayed.
 */

export type BillingProductKey = 'learning' | 'sentinel_pro';

export interface BillingProduct {
  key: BillingProductKey;
  name: string;
  /** Stripe Tax product tax code. Taken from the owner's Dashboard products. */
  taxCode: string;
  /** Env var that may pin the Stripe Product id (test and live ids differ). */
  productIdEnv: string;
}

export const BILLING_PRODUCTS: Record<BillingProductKey, BillingProduct> = {
  learning: {
    key: 'learning',
    name: 'Learning',
    taxCode: 'txcd_20060052', // Educational Services
    productIdEnv: 'STRIPE_PRODUCT_LEARNING',
  },
  sentinel_pro: {
    key: 'sentinel_pro',
    name: 'Sentinel Pro',
    taxCode: 'txcd_10000000', // General: Electronically Supplied Services
    productIdEnv: 'STRIPE_PRODUCT_SENTINEL_PRO',
  },
};

export interface BillingItem {
  /** Stable id used on the wire, in metadata and in `BillingOrder.itemId`. */
  id: string;
  label: string;
  product: BillingProductKey;
  /** Database `Plan.code` activated on payment. */
  planCode: string;
  kind: 'recurring' | 'one_time';
  /** Charged per billing period (recurring) or once (one_time), in US cents. */
  amountMinor: number;
  currency: 'usd';
  /** Recurring items: renew every `intervalCount` months. */
  intervalCount?: number;
  /** One-time items: access granted, in days. */
  days?: number;
  /** Stripe Price lookup key (recurring items). */
  lookupKey?: string;
  /** Claimable once per account, ever (recorded in UsageCounter). */
  oncePerUser?: boolean;
  claimMetric?: string;
  /** Where the purchase is used, for the confirmation email CTA. */
  accessPath: string;
}

/** Metric and period under which a consumed one-time trial is recorded. */
export const TRIAL_CLAIM_METRIC = 'sentinel_trial';
export const TRIAL_PERIOD_KEY = 'lifetime';

export const BILLING_CURRENCY = 'usd' as const;

export const LEARNING_ITEM: BillingItem = {
  id: 'learning_monthly',
  label: 'Learning Pro (monthly)',
  product: 'learning',
  planCode: 'learning_pro',
  kind: 'recurring',
  amountMinor: LEARNING_MONTHLY,
  currency: BILLING_CURRENCY,
  intervalCount: 1,
  lookupKey: 'tradew_learning_monthly_usd',
  accessPath: '/learning',
};

export const SENTINEL_ITEMS: ReadonlyArray<BillingItem> = SENTINEL_TERMS.map((t) => ({
  id: t.id,
  label: t.months === 1 ? 'Sentinel Pro (monthly)' : `Sentinel Pro (every ${t.months} months)`,
  product: 'sentinel_pro' as const,
  planCode: 'sentinel_pro',
  kind: 'recurring' as const,
  amountMinor: t.total,
  currency: BILLING_CURRENCY,
  intervalCount: t.months,
  lookupKey: `tradew_${t.id}_usd`,
  accessPath: '/sentinel',
}));

/** The 7-day pass: a one-time PaymentIntent, not a subscription. */
export const TRIAL_ITEM: BillingItem = {
  id: SENTINEL_TRIAL.id,
  label: `Sentinel Pro ${SENTINEL_TRIAL.term} pass`,
  product: 'sentinel_pro',
  planCode: 'sentinel_pro',
  kind: 'one_time',
  amountMinor: SENTINEL_TRIAL.price,
  currency: BILLING_CURRENCY,
  days: SENTINEL_TRIAL.days,
  oncePerUser: true,
  claimMetric: TRIAL_CLAIM_METRIC,
  accessPath: '/sentinel',
};

export const BILLING_ITEMS: ReadonlyArray<BillingItem> = [LEARNING_ITEM, ...SENTINEL_ITEMS, TRIAL_ITEM];
export const RECURRING_ITEMS = BILLING_ITEMS.filter((i) => i.kind === 'recurring');

export function billingItem(id: string): BillingItem | undefined {
  return BILLING_ITEMS.find((i) => i.id === id);
}

/** Display label for a catalog item's price. */
export function priceLabel(item: BillingItem): string {
  if (item.kind === 'one_time') return usd(item.amountMinor);
  return item.intervalCount === 1 ? `${usd(item.amountMinor)}/month` : `${usd(item.amountMinor)} every ${item.intervalCount} months`;
}

export function formatMinor(amountMinor: number, currency: string = BILLING_CURRENCY): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountMinor / 100);
}
