---
type: research
date: 2026-08-10
tags: [security, auth, secrets, findings, assessment]
---

# Offensive security assessment — 2026-08-10

Full architecture + offensive review of `services/api`, `services/sentinel`, the feed bridge, and `apps/web`. Findings verified with live PoCs against the running stack, then fixed with targeted edits (Rule 1) and pinned with regression tests. See memory `sec-jwt-fallback-secret`.

## Findings (severity)

1. **CRITICAL — JWT forgery / full auth bypass.** `app.module.ts` signed tokens with `process.env.JWT_SECRET || 'dev-secret-change-me'`, and `.env` set exactly that. The fallback is in source, so any `sub` can be minted offline. PoC: forged a token for the real admin's user id → `GET /auth/me` 200 + `/sim/portfolio` 200 (read live balance) with no password; also bypassed `AdminGuard`'s DB `isAdmin` check by forging with an admin's `sub`. **Fix:** `common/secret-validation.ts` `resolveSecret()` aborts boot on missing/placeholder/short/vendor-key secrets; `JwtModule` uses it. Verified: old forged token now 401, real login still 201.

2. **HIGH — ADMIN_API_TOKEN was a live Anthropic key.** `ADMIN_API_TOKEN === ANTHROPIC_API_KEY` (`sk-ant-…`, sha256:8=97269ac5). A paid vendor credential doubled as the operator secret. **Fix:** `AdminGuard`/`AdminTokenGuard` reject a structurally-invalid token (vendor prefix / <24 chars / placeholder) → surface fails closed. Rotated `.env` to a distinct random value.

3. **HIGH — services bound to all interfaces.** `services/api` `app.listen(port)` and the feed bridge `server.listen(PORT)` bound `0.0.0.0`/`::`; both reachable over the LAN (verified via LAN-IP curl). The bridge has NO auth and its docstring claims "bound to localhost" as its only boundary — false at runtime. **Fix:** default-bind `127.0.0.1`, override with `HOST`/`DHAN_LIVE_HOST` (matches `services/sentinel`). Verified: `:4000` now loopback-only, LAN curl refused.

4. **MEDIUM — weak internal service token.** `SERVICE_TOKEN`/`SENTINEL_SERVICE_TOKEN` = `dev-sentinel-token` (in repo history), non-constant-time compare. **Fix:** sentinel `ServiceTokenGuard` fails closed on weak/unset/short + `timingSafeEqual`. Rotated `.env` (matched pair).

5. **INFO — Swagger `/docs` + Knowledge Workspace default-on when `NODE_ENV` unset.** By design for dev; the risk is a prod deploy without `NODE_ENV=production`. `.env.prod` also had weak `JWT_SECRET`(18)/`ADMIN_API_TOKEN`(19) — now blocked by fix #1/#2 at boot.

6. **HIGH — premium entitlement bypass (Sentinel free for everyone).** `EntitlementsService.check()` had `if (capability === 'sentinel') return { allowed:true, reason:'trial' }` (and `capabilitiesOf()` did `result.add('sentinel')`), so the flagship PREMIUM capability was granted to every account regardless of subscription — and it silently overrode admin *revocations* (a refund/ban couldn't take Sentinel away). It also made this service's own 18 well-authored spec cases fail on clean HEAD. **Fix:** removed both short-circuits so Sentinel flows through the normal override→subscription→quota path. Verified live: admin (has a granting override) keeps access `reason:'override'`; a fresh no-entitlement user gets `no_subscription` and `POST /sentinel/observe` → 403. All 25 entitlements tests pass; full API suite 248/248.

## Leak scope
`.env`/`.env.prod` are **not** git-tracked and **never committed** (verified). No real secret in tracked source or history — only redacted placeholders in knowledge notes. Exposure = working-tree/local-disk only. Live secrets still present in `.env`: `DHAN_ACCESS_TOKEN` (live broker), `ANTHROPIC_API_KEY`, `TWELVEDATA_API_KEY`, `NVIDIA_NIM_API_KEY` — rotation is a vendor-console action for the user.

## Tests (pin against reintroduction)
`services/api/src/common/secret-validation.spec.ts`, `services/api/src/auth/admin-token-guard.spec.ts`, `services/sentinel/src/service-token-guard.spec.ts`; broker-authz fixture bumped to a ≥24-char token. Pre-existing: `entitlements.spec.ts` fails 18 on clean HEAD (unrelated, DB-shaped — not touched).
