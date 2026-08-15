---
title: Razorpay payment seam, EOD summary email, single-VPS deploy
date: 2026-08-11
tags: [payments, razorpay, entitlements, eod, scheduler, deploy, docker, admin]
---

# Razorpay payments, EOD email, single-VPS deploy

Follow-on to [[2026-08-11 - Transactional email + in-app notification wiring]] (same program). **Read before touching payments, the EOD job, or the prod compose.**

> **Extended 2026-08-15** by [[2026-08-15 - Sentinel pre-payment page (day-length terms, durable claims, the shell that owned the session)]] — the catalog now also carries a DAY-length, once-per-account item (the paid 7-day trial). The "Catalog scope: Sentinel Pro terms only" note below still holds for renewable terms; the trial sits beside `CATALOG` rather than in it, and `fulfil` branches on `days` vs `months`. Read that note before adding any catalog item.

## Payments — Razorpay seam (`services/api/src/payments/`)
- **No SDK dep** — raw REST + Node `crypto`, same rationale as `GoogleOauthService`. `RazorpayClient`: `createOrder` (Basic auth), `verifyPaymentSignature` (HMAC `${order}|${payment}` with key secret), `verifyWebhookSignature` (HMAC raw body with webhook secret). Constant-time compares.
- **Unconfigured is first-class**: no `RAZORPAY_KEY_ID/SECRET` → `configured=false`, catalog returns `billingEnabled:false`, checkout refuses. Mirrors `/pricing`.
- **Fulfilment goes through `EntitlementsService.activate(planCode, {expiresAt})`** — the ONLY sanctioned subscription lifecycle seam (that service's own note mandates it). Never write Subscription rows directly from a billing adapter except to stamp `billingProvider`/`billingReference` after activate.
- **IDEMPOTENT on the Razorpay payment id** (`Subscription.billingReference`). Callback (`/verify`) and webhook (`/webhook`) both fire for one payment — a payment id that already backs a subscription is a no-op. Never grant two terms for one charge.
- **Trust = signature, not the browser.** `/verify` (widget callback) and `/webhook` (authoritative, retried) both require a valid HMAC before anything is granted. Webhook reads `req.rawBody` (works because `main.ts` boots `rawBody:true`).
- **Catalog scope**: Sentinel Pro terms only (`CATALOG` from `SENTINEL_TERMS` → plan `sentinel_pro`). Learning/demo deliberately excluded — their plan-code mapping is an unresolved product decision; charging without a correct plan map is worse than not selling.
- Frontend: `apps/web/src/app/(workspace)/checkout` + `lib/payments.ts` (loads checkout.js on demand, relays signed result). **CSP** in `next.config.mjs` extended with `RAZORPAY_SCRIPT/FRAME/CONNECT` constants — Razorpay's the reason `frame-src` exists in that policy now.
- Env: `RAZORPAY_KEY_ID` (publishable, sent to browser), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Webhook → `${API_PUBLIC_URL}/api/payments/webhook`, events payment.captured/order.paid/payment.failed.

## EOD summary email (`services/api/src/sim/eod-summary.service.ts`)
- Reuses the **PerformanceService sweep pattern verbatim** (`LeaderElectionService.register/isLeader` + coarse `setInterval` + `market-calendar` `isTradingDay`/`istDateKey`/`istMidnightUtc`). Put it in `SimModule` (which owns `PortfolioService`); had to add `NotificationModule` to SimModule imports.
- **4 gates so it can't spam**: leader-only, trading-day-only, after-`EOD_EMAIL_HOUR_IST` (default 16 IST, past 15:30 close), once-per-user-per-day via durable `UserPreference` marker `eod_email_last_sent={dateKey}`. Marker set only after `mail.send` reports delivered/preview, so a hard SMTP failure retries next tick.
- **OFF by default** (`EOD_EMAIL_ENABLED=true` to enable) — sending real mail to every user is opt-in. Per-user opt-out pref `eod_email_enabled=false`. Skips `…@phone.tradew.local`.
- Data: `PortfolioService.summary` (netWorth, dailyPnl) + `Order` rows for the IST day (`placedAt`, `instrument.symbol`, `avgFillPrice ?? price`).

## Google login (Phase 5)
- The code (`google-oauth.service.ts`) was always correct. Root cause of "Google login does nothing" = `GOOGLE_CLIENT_ID/SECRET` were **never set** → `/auth/google` 503 by design. Fix is config only: env scaffolding added to `.env`/`.env.example`/`.env.prod.example`. Redirect URI must equal `${API_PUBLIC_URL}/auth/google/callback` exactly.

## Deploy — single VPS + docker-compose
- `infra/docker/docker-compose.prod.yml` (pre-existing, comprehensive: Caddy + web + api + sentinel + market-data + live-feed + migrate one-shot + pg/pgvector + redis) is the dev-deploy target. Runbook: `infra/docker/DEPLOY-DEV.md`.
- **Admin console is operator-only**: new `apps/admin/Dockerfile` (mirrors web's) + `infra/docker/docker-compose.admin.yml` override that binds admin to `127.0.0.1:3001` (reachable via `ssh -L`, NEVER through Caddy/public). Run with `-f prod -f admin`. Two-factor still applies (signed cookie + `ADMIN_API_TOKEN`).
- `.env.prod.example` updated with every new var (SMTP/MAIL, GOOGLE, RAZORPAY, EOD, ADMIN_API_TOKEN, API_PUBLIC_URL, IMAGE_ADMIN). Compose `prod`+`admin` merge validated with `docker compose config`.

## Verified / limits
- `services/api` + `apps/web` `tsc --noEmit` clean. Compose merge validates. **Not** run end-to-end against a live stack (no local bring-up performed); Razorpay/Google/SMTP need the user's real keys to exercise.
