# Sentinel pricing as a standalone route — superseded 2026-08-15

Retained per CLAUDE.md Rule 1. Nothing here is referenced by the live tree.

Built earlier the same day as a public `/sentinel/pricing` route, then replaced within hours by a conditional view inside `/sentinel`. The pricing UI itself was **not** the problem and was carried over intact — `PricingTierCard`, `TrialOffer`, `SentinelPreview` and `FeatureList` are unchanged and still live at `apps/web/src/components/sentinel/pricing/`. What was superseded is the decision to make it a **route**.

## Files

- **`app-sentinel-pricing-page.tsx.txt`** — `apps/web/src/app/sentinel/pricing/page.tsx`, the bare route outside the `(workspace)` group.
- **`SentinelPricingClient.tsx.txt`** — its client component. Superseded by `components/sentinel/SentinelPricingView.tsx`, which is the same sections minus everything that existed only to cope with being a separate public route.
- **`SentinelLocked.tsx.txt`** — the older locked-state panel `/sentinel` rendered for an account without the capability. Superseded by the pricing view, which now fills that slot. **Its coupon-redemption form was carried over** rather than dropped — see the "Have a code?" block in `SentinelPricingView.tsx`.

## Why it changed

A separate route made three things awkward, each a direct consequence of the split:

1. **Public by construction.** It had to be added to `middleware.ts`'s `PUBLIC_PATHS`, which meant pricing was readable with no account at all. The requirement changed to sign-in first.
2. **It had to bootstrap its own session.** `AppFrame` is the only route-level caller of `sessionStore.init()`, and this page deliberately sat outside that shell, so it carried its own `init()` effect. Inside the workspace that is simply not needed.
3. **Buying meant navigating.** Payment ended in `router.replace('/sentinel')`. As a view, the entitlement landing in the store swaps pricing for the workspace in place — no route change, no reload, sidebar untouched.

The `(workspace)`-group reasoning that put it outside the shell was sound for a *public marketing* page and is preserved in the archived file's header comment. It stopped applying once the page required a session: a signed-in user should see the sidebar.
