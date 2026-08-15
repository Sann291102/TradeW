# apps/admin 🟢

The internal ops/support/compliance console — **now built** as a standalone Next.js app (port 3001) with its own operator-account auth, separate from `apps/web`. It grew out of needs already visible in the original audit:

- The trading engine has an unfinished **Dead Letter Queue** (table exists, no retry worker or UI) — admin gives ops a place to inspect and retry stuck orders once the worker is built.
- The auth module already logs **audit events** (login/signup/refresh, IP/UA) — admin is where someone actually reads that log, rather than querying the database by hand.
- KYC/compliance review (SEBI algo-trading rules, DPDP Act per the architecture doc) needs a human-in-the-loop screen somewhere that isn't the trader-facing app.

**Talks to:** `services/api` only, through an authenticated server-side proxy (`src/app/api/proxy/[...path]`) — same single-ingress rule as `apps/web`. Double-gated: an operator JWT (`OperatorAccount`, `composed AdminAccessGuard`) plus the shared `ADMIN_API_TOKEN`. Never public — loopback-bound + SSH-tunnel only (see [`infra/docker/DEPLOY-DEV.md`](../../infra/docker/DEPLOY-DEV.md)).

**Depends on:** `packages/ui`, `packages/types`. (`packages/sdk` is still unbuilt, so it calls `services/api` via the proxy directly.)

## Status: 🟢 built

Standalone console live on port 3001 (`npm run dev:admin`). Command centers (`src/app/(console)/`): **agents, ai, audit, orders, rules, system, health, observability, learning-platform, reasoning, knowledge**, plus a **cognition** neural-layers graph console and a live knowledge SSE stream (`api/stream/knowledge`). Read-only aggregations over `services/api`; a "View as Trader" passthrough to `apps/web`. Operator accounts are created via `packages/database`'s `operator:create` script.

**Roadmap items still open:** the KYC/compliance review UI and the DLQ retry-worker UI (the DLQ worker itself is still unbuilt on the engine side).
