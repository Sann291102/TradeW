import { SENTINEL_TERMS, SENTINEL_TRIAL, CURRENCY, inr } from '@tradew/types';

/**
 * What can actually be bought, and what buying it grants.
 *
 * The seam between a PRICE (display, owned by `@tradew/types`) and a PLAN
 * (entitlement, owned by the database `Plan.code`). A checkout item names both:
 * the rupee amount to charge and the plan-code + duration to activate on
 * success. Keeping the two joined here — rather than in the payment flow — is
 * what stops "charged ₹X but granted the wrong plan" bugs.
 *
 * SCOPE: Sentinel Pro terms only, deliberately. Those map unambiguously to the
 * seeded `sentinel_pro` plan (packages/database/prisma/seed.ts). Learning Hub
 * (₹299) and the demo passes are intentionally NOT sold here yet — their
 * plan-code mapping is a product decision (Learning grants ≠ any single seeded
 * plan cleanly), and charging for an item we can't correctly fulfil is worse
 * than not offering it. Add them here once that mapping is confirmed.
 */
export interface CatalogItem {
  /** Stable id used on the wire and as Razorpay `notes.itemId`. */
  id: string;
  label: string;
  /** Database `Plan.code` to activate on a successful payment. */
  planCode: string;
  /** Subscription length granted, in months. Zero for day-length items. */
  months: number;
  /**
   * Subscription length granted, in DAYS — set instead of `months` for terms
   * too short to express in months. Exactly one of the two is meaningful, and
   * `days` wins where present.
   */
  days?: number;
  /** Whole rupees charged up front for the whole term. */
  amountInr: number;
  /**
   * Claimable once per account, ever. The claim is recorded durably against
   * `claimMetric` so it survives the subscription it granted expiring — a
   * "one-time offer" enforced only by looking for a live subscription becomes
   * repeatable the moment the first one lapses.
   */
  oncePerUser?: boolean;
  /** `UsageCounter.metric` that records the one-time claim. */
  claimMetric?: string;
}

export const CATALOG: ReadonlyArray<CatalogItem> = SENTINEL_TERMS.map((t) => ({
  id: t.id, // sentinel_1m | sentinel_3m | sentinel_6m
  label: `Sentinel Pro — ${t.term}`,
  planCode: 'sentinel_pro',
  months: t.months,
  amountInr: t.total,
}));

/** Metric under which a consumed trial is recorded. See `TRIAL_PERIOD_KEY`. */
export const TRIAL_CLAIM_METRIC = 'sentinel_trial';

/**
 * `UsageCounter` is keyed `(userId, metric, periodKey)` and every other caller
 * passes a day or month key. The trial is a LIFETIME claim, so it needs a
 * period that never rolls over — this constant is that period, and the unique
 * constraint on the triple is what makes the claim race-safe.
 */
export const TRIAL_PERIOD_KEY = 'lifetime';

/**
 * The paid 7-day trial — deliberately NOT in `CATALOG`.
 *
 * `CATALOG` is the list of renewable subscription terms; `/checkout` renders it
 * and divides by `months` to show a per-month rate. A zero-month entry in that
 * list would render as ₹Infinity/mo on a screen this change never touched. It
 * is still resolvable by `catalogItem()`, so checkout, verify and the webhook
 * all fulfil it through exactly the same path as a full term.
 */
export const TRIAL_ITEM: CatalogItem = {
  id: SENTINEL_TRIAL.id,
  label: `Sentinel Pro — ${SENTINEL_TRIAL.term}`,
  planCode: 'sentinel_pro',
  months: 0,
  days: SENTINEL_TRIAL.days,
  amountInr: SENTINEL_TRIAL.price,
  oncePerUser: true,
  claimMetric: TRIAL_CLAIM_METRIC,
};

export function catalogItem(id: string): CatalogItem | undefined {
  if (id === TRIAL_ITEM.id) return TRIAL_ITEM;
  return CATALOG.find((i) => i.id === id);
}

/** Razorpay works in the smallest currency unit — paise for INR. */
export function toPaise(amountInr: number): number {
  return Math.round(amountInr * 100);
}

export const CATALOG_CURRENCY = CURRENCY; // 'INR'
export const formatInr = inr;
