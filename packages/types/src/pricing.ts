/**
 * Canonical TradeW pricing — the single source of truth.
 *
 * ── WHY THIS IS IN packages/types ──────────────────────────────────────────
 *
 * Before this file, prices existed in exactly two places, both of them screens:
 * `apps/web`'s Settings page and the marketing landing page. There was no
 * backend pricing configuration at all — `Plan` in schema.prisma has `code`,
 * `name`, `description`, trial/grace days and capability grants, and no money
 * anywhere on it. Two hardcoded frontend copies of a price list is how a
 * product ends up quoting different numbers on the marketing page and the
 * upgrade screen.
 *
 * So the list lives here, in the package both apps and services already depend
 * on, and `services/api` serves it at `GET /pricing`. Changing a price is one
 * edit in one file.
 *
 * ── PRICES ARE DISPLAY, NOT BILLING ────────────────────────────────────────
 *
 * Nothing here charges anyone. There is no payment provider wired (an open
 * decision in SUBSCRIPTIONS.md §6) and no checkout. These values exist so the
 * product can state its own prices consistently and honestly. When billing
 * lands, the provider's price objects become the source of truth for what is
 * actually charged and these become what is *displayed* — they must be
 * reconciled, never allowed to drift.
 *
 * ── AND THERE IS NO ANNUAL SENTINEL PLAN ───────────────────────────────────
 *
 * Removed 2026-08-11 at product direction. The previous ladder ran to 9 and 12
 * months (₹1,099 and ₹999/mo). Those terms are gone from the product, not
 * merely hidden: there is no code path, API response or route that can produce
 * them, and `pricing.spec.ts` asserts their absence rather than trusting that
 * nobody re-adds one.
 */

export const CURRENCY = 'INR' as const;

/** A Sentinel subscription term. `monthly` is the per-month equivalent. */
export interface SentinelTerm {
  /** Stable id — safe to use as a key or in a URL. */
  id: 'sentinel_1m' | 'sentinel_3m' | 'sentinel_6m';
  /** Human label. */
  term: string;
  /** Billed term length in months. */
  months: 1 | 3 | 6;
  /** Per-month equivalent, in whole rupees. */
  monthly: number;
  /** Total payable up front for the whole term, in whole rupees. */
  total: number;
}

/**
 * Sentinel terms, 2026-08-11.
 *
 * The quoted figures (₹2,399 / ₹2,199 / ₹1,999) are PER-MONTH equivalents, not
 * totals — a longer commitment costs less per month, which is the only reading
 * under which the ladder descends. `total` is derived below rather than typed
 * by hand so the two can never disagree.
 */
const SENTINEL_MONTHLY: ReadonlyArray<Omit<SentinelTerm, 'total'>> = [
  { id: 'sentinel_1m', term: '1 Month', months: 1, monthly: 2399 },
  { id: 'sentinel_3m', term: '3 Months', months: 3, monthly: 2199 },
  { id: 'sentinel_6m', term: '6 Months', months: 6, monthly: 1999 },
];

export const SENTINEL_TERMS: ReadonlyArray<SentinelTerm> = SENTINEL_MONTHLY.map((t) => ({
  ...t,
  total: t.monthly * t.months,
}));

/** The single-month rate every saving is measured against. */
export const SENTINEL_BASE_MONTHLY = SENTINEL_TERMS[0]!.monthly;

/**
 * What a term saves against paying monthly, in whole rupees. Zero for 1 month.
 *
 * SUBSCRIPTIONS.md §3 makes showing this a requirement on the pricing
 * component rather than a nicety, so it is computed here — a UI that has to
 * work out its own savings is a UI that will eventually work them out wrongly.
 */
export function sentinelSaving(term: SentinelTerm): number {
  return (SENTINEL_BASE_MONTHLY - term.monthly) * term.months;
}

/**
 * The paid 7-day Sentinel trial, 2026-08-15.
 *
 * A short paid taste of Sentinel for the pre-payment landing page, priced off
 * the one-month term rather than picked: take the daily rate the ₹2,399 month
 * implies, discount it, and charge seven of those days.
 *
 *   2399 / 7 = 342.71/day  →  −20%  =  274.17  →  ₹275
 *
 * DERIVED, NOT TYPED. Every figure below falls out of `SENTINEL_BASE_MONTHLY`,
 * so a change to the one-month price re-prices the trial with it. Hand-typing
 * ₹275 here is how the trial survives a price rise and quietly becomes a
 * discount nobody approved — the same failure `total` is derived to avoid.
 *
 * The ₹5 rounding step is presentation, not slack: it keeps the charged figure
 * clean without ever landing below the discounted rate by more than rounding.
 */
export const SENTINEL_TRIAL_DAYS = 7;
export const SENTINEL_TRIAL_DISCOUNT_PCT = 20;

export interface SentinelTrial {
  /** Stable id — used on the wire and as the Razorpay `notes.itemId`. */
  id: 'sentinel_trial_7d';
  term: string;
  /** Access granted, in days. */
  days: number;
  /** Undiscounted daily rate implied by the one-month term, for display. */
  dailyRate: number;
  discountPct: number;
  /** Whole rupees actually charged. */
  price: number;
}

const trialUndiscountedDaily = SENTINEL_BASE_MONTHLY / SENTINEL_TRIAL_DAYS;

export const SENTINEL_TRIAL: SentinelTrial = {
  id: 'sentinel_trial_7d',
  term: '7-Day Trial',
  days: SENTINEL_TRIAL_DAYS,
  dailyRate: Math.round(trialUndiscountedDaily),
  discountPct: SENTINEL_TRIAL_DISCOUNT_PCT,
  price: Math.round((trialUndiscountedDaily * (100 - SENTINEL_TRIAL_DISCOUNT_PCT)) / 100 / 5) * 5,
};

/**
 * Learning Hub, 2026-08-11: a monthly subscription.
 *
 * This REPLACES the previous ₹299 one-time lifetime purchase. Lifetime access
 * still exists but is now earned rather than bought — see the Lifetime Free
 * entitlement, whose eligibility is calculated and enforced server-side.
 */
export const LEARNING_MONTHLY = 299;

/** Paper-trading passes. Unchanged. */
export const DEMO_PASSES = [
  { id: 'demo_week', term: '7 days', days: 7, price: 99 },
  { id: 'demo_month', term: '30 days', days: 30, price: 199 },
] as const;

/** Free-tier paper order allowance per day (SUBSCRIPTIONS.md §1). */
export const FREE_PAPER_ORDERS_PER_DAY = 2;

/** Format whole rupees the Indian way: ₹11,994. */
export function inr(amount: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(amount)}`;
}

/**
 * Terms that were withdrawn and must never come back silently.
 *
 * Exported so the test suite can assert against a named list rather than a
 * magic number buried in an expectation — if a 9- or 12-month Sentinel term is
 * ever reintroduced, that is a product decision that edits this constant, not
 * an accident that slips through review.
 */
export const WITHDRAWN_SENTINEL_MONTHS: ReadonlyArray<number> = [9, 12];
