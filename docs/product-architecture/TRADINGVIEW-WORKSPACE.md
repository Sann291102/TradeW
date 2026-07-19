# TradingView Workspace — Product Blueprint

Status: design, pre-implementation.

## 1. What it is

A dedicated charting workspace launched inside `tv.tradew-setup.com`, reachable from `apps/web` (nav item + the assistant's "Open TradingView" command, `TRADEW-ASSISTANT.md` §3) without feeling like leaving the platform.

## 2. Never feels like leaving the platform

The shared top bar/sidebar chrome (`DESIGN-SYSTEM.md` §3) wraps the TradingView embed exactly like every other workspace — it is a route within `apps/web`, not an external link that opens a new tab. The embed itself (iframe or TradingView's charting library, whichever `tv.tradew-setup.com` is actually built on — that's an implementation detail for whoever stands up that subdomain, not specified here) fills the content area below the shared chrome.

## 3. Authentication handoff

`apps/web` already holds the user's `services/api` session. On entering the TradingView workspace, `services/api` issues a short-lived, scoped SSO token (not the user's main session JWT — a narrower token whose only claim is "authenticated TradeW user," per the same least-privilege reasoning as service-to-service tokens in `ARCHITECTURE.md` §3) that `tv.tradew-setup.com` validates. The user never sees a second login prompt.

## 4. Workspace/layout persistence

Chart layouts, saved drawings, and indicator presets created inside the TradingView workspace persist per-user across sessions — owned by whatever `tv.tradew-setup.com` itself uses for storage (likely TradingView's own layout persistence if using their charting library, or a dedicated `tradingview_layouts` table under `services/api` if building the embed from scratch). Exact choice depends on how `tv.tradew-setup.com` is actually implemented — flagged as open, not guessed.

## 5. Guardrails

Same as every other workspace: TradingView's own alerting/scripting surface is a charting tool, not an order-entry path. If TradeW ever wires a "trade from chart" action here, it must route through the normal order-entry flow (`ARCHITECTURE.md` §3) — never a direct call from the embed to `trading-engine`.

## 6. Open items

- Whether `tv.tradew-setup.com` is self-hosted (TradingView Charting Library license) or a TradingView-hosted white-label — a licensing/vendor decision outside this document's scope.
- Exact SSO token mechanism (JWT with short TTL vs. one-time handoff code) — a detail for implementation time.
