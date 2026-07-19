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

Lifetime Access — ₹299, one-time. Grants all current content plus every future update (`LEARNING-HUB.md` §5). No recurring billing for this tier.

## 3. Sentinel

Monthly-equivalent pricing, billed as the stated term:

| Term | Monthly equivalent | Total payable |
|---|---|---|
| 1 month | ₹1,399 | ₹1,399 |
| 3 months | ₹1,299/mo | ₹3,897 |
| 6 months | ₹1,199/mo | ₹7,194 |
| 9 months | ₹1,099/mo | ₹9,891 |
| 12 months | ₹999/mo | ₹11,988 |

UI must show savings explicitly (e.g. "Save ₹4,800 vs monthly" on the 12-month tier) — this is a display requirement on the pricing component, not just a data table.

## 4. Entitlement gating (reuses existing architecture, no new pattern)

Sentinel's entitlement architecture is already locked as part of the platform's AI foundation — `services/api` is the single chokepoint that checks a user's active entitlement before proxying a request to `services/sentinel`. This document doesn't introduce a new gating mechanism; it extends the same check to two more resources:

- Sentinel nav/dashboard/widgets: always visible; premium analysis content is replaced with **Start Free Trial** / **Upgrade Plan** CTAs when the entitlement check fails — per the brief, never a silently-missing feature.
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
