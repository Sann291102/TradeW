---
title: Sentinel pre-payment landing page — day-length terms, durable claims, and the shell that owned the session
date: 2026-08-15
tags: [payments, razorpay, entitlements, pricing, sentinel, marketing, nextjs, middleware]
---

# Sentinel pre-payment page (day-length terms, durable claims, the shell that owned the session)

Extends [[2026-08-11 - Razorpay payments, EOD email, VPS deploy]] — same seam, three new capabilities. **Read before adding a catalog item, a public route, or any page outside `(workspace)`.**

Sells the three existing terms plus a new paid 7-day trial. Backend additive; the existing `/checkout` path is untouched.

> **⚠️ SUPERSEDED SAME DAY — the route is now a VIEW.** This was first built as a public standalone `/sentinel/pricing`. Hours later it became a conditional render inside `/sentinel`; the route is archived at `archive/apps-web-sentinel-pricing-route-2026-08-15/` and no longer exists. **Everything below about the payment seam, the derived trial price, and durable claims is unchanged and current.** The two sections marked *(historical)* describe the route form; the "Route became a view" section at the end records what replaced it and why. The AppFrame/`init()` finding is still true of *any* page outside `(workspace)` — it simply no longer applies to this one.

## The price conflict, and why the repo won

The brief specified ₹2,499 / ₹2,299×3. `packages/types/src/pricing.ts` said ₹2,399 / ₹2,199 — **pinned by two test suites**, served by `GET /pricing`, and rendered on the landing page and Settings. Asked rather than assumed; direction was to keep the repo's figures. Nothing repriced, no test changed.

The general rule this confirms: **a figure in a brief is a proposal, a figure in `pricing.ts` is a commitment.** Reconcile deliberately, never by editing whichever one is in front of you.

## The trial price is DERIVED

`SENTINEL_TRIAL` computes from `SENTINEL_BASE_MONTHLY`, never typed:

```
2399 / 7 = 342.71/day  →  −20%  =  274.17  →  ₹275   (rounded to a ₹5 step)
```

Hand-typing ₹275 is how a trial survives a price rise and quietly becomes a discount nobody approved — the same reason `total` is derived from `monthly × months`. A test asserts the formula, not the literal, so raising the one-month price re-prices the trial instead of failing.

## Day-length terms without breaking the month-shaped ones

`CatalogItem` gained `days?`, `oncePerUser?`, `claimMetric?`. Three decisions worth keeping:

- **`TRIAL_ITEM` is deliberately NOT in `CATALOG`.** `CATALOG` is the renewable-terms list and `/checkout` divides by `months` to show a per-month rate — a zero-month row renders **₹Infinity/mo** on a screen this change never touched. It is still resolvable via `catalogItem()`, so checkout/verify/webhook fulfil it through the identical path.
- **`fulfil` restates `trialEndsAt` from the term PAID FOR.** `EntitlementsService.activate({trial:true})` derives it from `Plan.trialDays`, a **seed value** — so editing the seed would silently change what a charge buys. The charged term is re-stamped in the same update that writes `billingReference`.
- Granted as `TRIALING`, so `check()` reports reason `'trial'` rather than passing a 7-day pass off as a purchased month. Note the plan's `graceDays: 3` applies to a trial like any term — that is plan policy, not special-cased here.

## Once-per-user has to be DURABLE, not "is there a live subscription"

The claim is a `UsageCounter` row at `(userId, 'sentinel_trial', periodKey: 'lifetime')` — a constant period because every other caller passes a day or month key.

**Enforcing "once" by looking for a live subscription makes the offer repeatable the moment the first one lapses.** That is the whole reason for a durable marker.

The unique constraint on the triple **is** the lock: `claim()` uses `create`, never `upsert`, because the constraint failing is the answer, and it is the only check two concurrent requests cannot both pass. Verified against the real database — the second insert returns **P2002**. Checked twice: in `createCheckout` (fail fast, before an order exists) and in `fulfil` (authoritative). A duplicate reaching `fulfil` is **logged as `ERROR` naming the payment id** — money was taken and not granted, which is a manual refund, and must not be silent.

`/payments/catalog` stays public and carries **no eligibility**; per-account state moved to a new authed `GET /payments/trial`.

## The bug only a browser could find: the shell owned the session *(historical — still true of any page outside `(workspace)`)*

The page sits outside the `(workspace)` route group so a signed-out visitor is not shown a sidebar of links they cannot open (the same call `(workspace)/layout.tsx` records for `/reset`).

**`AppFrame` is the only route-level caller of `sessionStore.init()`.** Outside it, nothing initialises the store, so `status` stays `'idle'` **forever** and every account-dependent behaviour inverted at once:

- a subscriber was never redirected to `/sentinel`
- trial eligibility was never fetched
- a signed-**in** user saw *"Sign in to check out"* and was bounced to the landing page **by their own Checkout button**

`tsc --noEmit` passed, 679 tests passed, and the page looked perfect signed out. Only a real session in a real browser showed it. Fixed with a mount effect guarded on `'idle'` (`init()` short-circuits with no network call when there is no token, so it is safe on a public page).

**The general shape: moving a page out of a layout silently drops everything that layout was doing for it.** Enumerate what the shell provides before leaving it.

## Route + middleware *(historical — the route no longer exists)*

`app/sentinel/pricing/page.tsx` (bare) coexists with `app/(workspace)/sentinel/page.tsx` — a route GROUP contributes no URL segment, so `/sentinel` and `/sentinel/pricing` are distinct paths. **`next build` confirms it**, emitting both as separate entries (31.1 kB / 10.5 kB). Not a conflict, but verify with a build rather than assuming.

`middleware.ts` gates on **exact pathname**, so `/sentinel/pricing` had to be added to `PUBLIC_PATHS` explicitly. Confirmed the gate did not widen: `/sentinel`, `/dashboard`, `/portfolio` all still 307. **Adding a sibling page under `app/sentinel/` without adding it to `PUBLIC_PATHS` will silently bounce signed-out visitors.**

## Two design-system traps, both still live

- **`bg-teal/5` is a silent no-op.** The preset maps colors to `var(--token)`, not rgb channels, so opacity modifiers do nothing and the panel renders **solid teal**. Use the `*-bg` tint tokens (`bg-teal-bg`, `bg-amber-bg`). Confirmed again here; already recorded in [[2026-08-05 - Sentinel workspace premium redesign (two-column rail layout)]].
- **A JSX `{/* comment */}` cannot precede the root element of a `return`** — it becomes an expression child with no parent and fails to parse.

## Content must render without JavaScript

First pass rendered the trial only after `/payments/catalog` resolved, so **₹275 — the page's headline offer — was absent from the server HTML entirely** and a skeleton until the fetch landed. Fixed by rendering from `@tradew/types` with the server catalog overriding, exactly as the tier cards already did.

The `curl | grep -c 'opacity:0'` check from [[2026-08-11 - Landing page as decision brief + mascot as shared agent identity]] was run and returns **0**. `Reveal` was copied to `components/common/Reveal.tsx` with its three load-bearing rules intact rather than imported from `LandingPage.tsx`, whose private copy is deliberately untouched.

## The route became a view (same day)

`/sentinel` now renders **one of two views** off the `sentinel` capability: `SentinelPricingView` or `SentinelWorkspace`. No redirect in either direction, and the standalone route is gone.

The reframing that makes it obvious: **the pricing page is a state of the Sentinel workspace, not a place.** Every awkward thing about the route form was a consequence of treating it as a destination — it had to be public, it had to bootstrap its own session, and buying had to `router.replace` you somewhere else. As a view, buying is a re-render.

Three things worth keeping:

- **A two-way branch on `hasCapability` shows paying subscribers the sales page for one frame on every load.** Until the session resolves the capability is false for *everyone*, so the branch needs a **third state**: `'idle' | 'loading'` renders neither view. Verified by sampling the DOM every 60 ms from first paint — the pricing hero never appears for an entitled account.
- **The entitlement gate sat BELOW `useSentinel()`**, so an account without Sentinel fired an `/observe` request on every render that could only ever 403. Splitting the workspace into `SentinelWorkspace.tsx` means its hooks do not run for someone who will not see it. *Check where a gate sits relative to the hooks it is supposed to gate.*
- **Activation is reported UP** (`onActivated`), because the component that triggers it is the one being unmounted — a toast owned by the pricing view dies with it. The parent owns the toast so it survives the flip.

`SentinelLocked`'s coupon-redemption form was **carried over, not dropped**, into the pricing view; redemption calls the same `activate()` as a purchase, so it flips the view identically. There is no toast primitive in this repo and one was not added for a single message.

**How to prove "no reload" rather than assume it:** stamp `window.__marker`, navigate, and check it survives. A full page load wipes it. It survived `/sentinel → /dashboard → /sentinel` and the purchase flip — which is also how the flip itself was verified end-to-end (via the coupon path, since billing is unconfigured locally and the two share `activate()`).

## Verified / limits

- `tsc --noEmit` clean (api + web); **354 api + 325 web tests pass**, 24 new; `next build` succeeds.
- Verified live: public read (200), workspace routes still gated (307), signed-out CTA → `/?next=%2Fsentinel%2Fpricing#auth`, signed-in claimed account → *"Already used"*, subscriber → redirected to `/sentinel`, `already_claimed` end-to-end, P2002 on a real duplicate insert, `/payments/trial` + `/payments/checkout` both 401 unauthed.
- **NOT verified: a real Razorpay payment.** This deployment has no keys, so `billingEnabled:false` and checkout refuses by design — the fulfilment branch (`addDays`, the `trialEndsAt` restatement, the duplicate-claim refund log) is covered by tests, not by a live charge. Exercising it needs test keys; see the runbook section in the change summary.
- The `createCheckout` claim refusal could not be reached live either: the `razorpay.configured` guard fires first when billing is off.
