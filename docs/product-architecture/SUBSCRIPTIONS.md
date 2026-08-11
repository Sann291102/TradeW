# Subscriptions & Monetization — Product Blueprint

Status: design, pre-implementation. Covers Demo Trading limits, Learning Hub, and Sentinel pricing, per the Genesis v2 brief. Billing provider is an open decision (§6) — everything else here is specified regardless of which provider is chosen.

## 1. Demo (paper) trading

| Tier | Price | Grant |
|---|---|---|
| Free | ₹0 | 2 paper order executions per day |
| Weekly Demo Pass | ₹99 | unlimited paper orders, 7 days |
| Monthly Demo Pass | ₹199 | unlimited paper orders, 30 days |

Daily free-order count resets at midnight IST via a scheduled job — see `N8N-WORKFLOWS.md`'s "Daily Demo Reset" entry. This counter is enforced at `services/api` (order-submission path, `ARCHITECTURE.md` §3), not client-side.

## 2. Learning Hub

**₹299 / month.**

> **Changed 2026-08-11.** This was a ₹299 one-time Lifetime Access purchase.
> Lifetime access still exists but is now **earned, not bought** — see the
> Lifetime Free entitlement in `LEARNING-HUB.md` §5, whose eligibility is
> calculated and enforced server-side from real participation records.

## 3. Sentinel

Monthly-equivalent pricing, billed as the stated term. **There is no annual
plan.**

| Term | Monthly equivalent | Total payable | Saving vs monthly |
|---|---|---|---|
| 1 month | ₹2,399 | ₹2,399 | — |
| 3 months | ₹2,199/mo | ₹6,597 | ₹600 |
| 6 months | ₹1,999/mo | ₹11,994 | ₹2,400 |

UI must show savings explicitly (e.g. "Save ₹2,400" on the 6-month tier) — this
is a display requirement on the pricing component, not just a data table.

> **Withdrawn 2026-08-11: the 9- and 12-month terms** (₹1,099 and ₹999/mo), and
> the whole previous ladder (₹1,399 / ₹1,299 / ₹1,199). They are gone from the
> product rather than hidden: no code path, API response or route can produce
> one. `packages/types/src/pricing.ts` is the single source of truth,
> `GET /pricing` serves it, and both `apps/web/src/lib/pricing.test.ts` and
> `services/api/src/pricing/pricing.spec.ts` assert their absence rather than
> trusting that nobody re-adds one.

**Prices live in code, once.** `packages/types/src/pricing.ts` is canonical.
They were previously hardcoded separately in the Settings page and the
marketing landing page, which is how a product ends up quoting one price to a
visitor and another to a subscriber. Do not reintroduce a local copy.

## 4. Entitlement gating (reuses existing architecture, no new pattern)

Sentinel's entitlement architecture is already locked as part of the platform's AI foundation — `services/api` is the single chokepoint that checks a user's active entitlement before proxying a request to `services/sentinel`. This document doesn't introduce a new gating mechanism; it extends the same check to two more resources:

- Sentinel has **two** gating surfaces (2026-07-21): a pre-auth marketing page's "Start Free" CTA, and — inside the application — an authenticated-but-unentitled user seeing an in-app locked state with an **Upgrade Plan** CTA in place of live observations. Either way the Sentinel nav item stays visible; entitlement gates reasoning, not visibility (`TRADEW-OS.md` §3). A note here briefly described the second surface as belonging to a separate Sentinel application; it is the `/sentinel` workspace inside TradeW (`SENTINEL.md` §5).
- Learning Hub: lesson *listing* stays open; lesson *body* content requires the lifetime entitlement (`LEARNING-HUB.md` §5).
- Demo trading: order-submission path checks the daily counter / active pass before allowing execution (§1).

## 5. Data model additions (owned by `services/api`)

| Table | Purpose |
|---|---|
| `entitlements` | user_id, product (`sentinel`/`learning_hub`/`demo_pass`), tier, expires_at (null = lifetime) |
| `demo_order_counter` | user_id, date, count — reset by the daily job |
| `billing_transactions` | payment provider reference, amount, product, status |

## 6. Open decision: billing provider

Not specified by the brief. Razorpay is the natural default for an India-first product (UPI support, SEBI-adjacent compliance familiarity) but this is a decision for whoever owns payments integration, not to be guessed here. Whichever provider is chosen, the `Payments` and `Subscription Billing` n8n workflows (`N8N-WORKFLOWS.md`) handle webhook-driven entitlement updates — `services/api` never trusts a client-reported payment success, only a verified webhook.

## 7. Non-goals

No trade execution is ever gated or ungated by a subscription tier in a way that implies TradeW is advising a trade because a user paid — entitlements unlock *intelligence surfaces* (Sentinel's observations, Learning Hub's content), never order-placement capability itself, which stays free and equally available at every tier (`ARCHITECTURE.md` §1's "no AI-initiated trades" applies regardless of billing state).
