import { SENTINEL_TERMS, CURRENCY, inr } from '@tradew/types';

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
  /** Subscription length granted, in months. */
  months: number;
  /** Whole rupees charged up front for the whole term. */
  amountInr: number;
}

export const CATALOG: ReadonlyArray<CatalogItem> = SENTINEL_TERMS.map((t) => ({
  id: t.id, // sentinel_1m | sentinel_3m | sentinel_6m
  label: `Sentinel Pro — ${t.term}`,
  planCode: 'sentinel_pro',
  months: t.months,
  amountInr: t.total,
}));

export function catalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((i) => i.id === id);
}

/** Razorpay works in the smallest currency unit — paise for INR. */
export function toPaise(amountInr: number): number {
  return Math.round(amountInr * 100);
}

export const CATALOG_CURRENCY = CURRENCY; // 'INR'
export const formatInr = inr;
