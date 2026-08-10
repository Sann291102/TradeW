---
type: plan
date: 2026-08-10
tags: [plan, infrastructure, scalability, security, load-testing, deployment]
---

# Production readiness audit — security, scalability, infrastructure

**Read before touching `infra/`, `services/api/src/common/`, any background
`setInterval`, or any Dockerfile.**

Full write-ups live in `docs/PRODUCTION-READINESS.md`,
`docs/CLOUD-ARCHITECTURE.md` and `docs/LOAD-TEST-REPORT.md`. This note records
only what a future agent needs that those documents do not make obvious.

## The finding that reframes everything else

**The application code was in better shape than the deployment path.** 500
concurrent users, p95 in single-digit milliseconds on every owned endpoint, zero
errors. And **two of the four Docker images had never successfully built**, with
four more defects behind them.

Build-time (loud, once anyone tries):

1. `services/api`'s Dockerfile never built `@tradew/types`, `@tradew/market-data`
   or `@tradew/ai-core`. They resolve through `types: dist/index.d.ts` and no
   package has a prepare/postinstall hook. 15 TS errors. `services/sentinel` and
   `services/market-data` already did this correctly — only the API's did not.
2. `apps/web`'s Dockerfile never built `@tradew/types`. Same class.
3. `.dockerignore` excluded all of `docs/`, but `apps/web` reads
   `docs/learning/` at build time for the strategy catalogue.

**Why nobody noticed:** a dev machine always has `packages/*/dist` from an
earlier `npm run build`, and `.dockerignore` excludes `dist` from the build
context. The only environment that reveals the gap is the container, and nothing
was building one.

Runtime (silent — starts, passes health checks, does not work):

4. `services/api`'s container never set `HOST`, and `main.ts` defaults to
   `127.0.0.1` — correct on a dev machine (that default came from the
   2026-08-10 offensive-security pass), fatal in a container, where Caddy then
   cannot reach it.
5. The Dhan live-feed bridge had **no container and no compose entry**, while
   `apps/web` proxies `/feed/*` to it and Sentinel reads its `/candles`. Also
   `web` had no `FEED_PROXY_TARGET`, so it defaulted to `127.0.0.1:4600` —
   itself.
6. **Sentinel's citation corpus was not in its image at all.** The worst of the
   six, because it is the quietest: `si.config.ts`'s `DEFAULT_CORPUS_ROOTS`
   scans `docs/Trading Books`, `docs/product-architecture`, `docs/handbook`,
   `knowledge/`, `knowledge-base/` and `agents/`, and `.dockerignore` excluded
   `docs` and `knowledge` while the Dockerfile copied none of them. The image
   builds, the container starts, `/health` passes, and the corpus is empty.
   Because the citation guarantee is **structural** — `VerdictBuilder.knowledge()`
   cannot be called without citations and the cross-checker *drops* uncited
   verdicts — an empty corpus raises nothing. It produces a Sentinel that never
   speaks, which is a designed and entirely normal-looking outcome of the
   publication gate.

**The generalisable lesson, and the reason to keep the new CI jobs:** defaults
chosen for developer safety become production bugs silently, and a repository
whose services read repo content as *data* has no way to distinguish
documentation from application content without someone writing it down. Both
`.dockerignore` and `services/sentinel/Dockerfile` now carry that in comments:
adding a corpus root in `si.config.ts` means editing both, or the feature ships
as a no-op.

## Leader election is a correctness mechanism, not an optimisation

`services/api/src/common/leader-election.ts` + the `JobLease` table (migration
`20260810120000_job_lease`).

Five loops ran on plain `setInterval`, each written as the only copy. With two
API replicas, **two matching engines can both fill the same resting order** —
a duplicated position on a user's book. So `replicas: 2` was never a capacity
setting; it was a correctness hazard wearing one's clothes.

Three decisions that will look wrong to someone skimming, and are not:

- **A lease row, not `pg_advisory_lock`.** Session-level advisory locks live on
  one connection and Prisma pools connections, so the holder and the next caller
  are usually different sessions — and behind PgBouncer in transaction mode
  session locks do not survive at all. The transaction-scoped variant does, but
  would hold a transaction open across a matching-engine tick, which makes
  outbound HTTP calls to the price bridge.
- **`isLeader()` is local, synchronous, and checks an expiry.** Going to the
  database per tick would add a round trip to the hot path and still return a
  point-in-time answer. What makes the local check safe is that it compares
  against a *deadline*: a paused or partitioned process cannot tell "I still
  hold this" from "it lapsed 30s ago", so it stands down on its own. Losing
  leadership is fail-safe; keeping it wrongly is not.
- **A database error does NOT immediately cost leadership** (a one-second blip
  must not stop order matching) but also does not extend it. Both halves are
  pinned by tests.

`holderId` is random per boot, not the hostname — platforms that reuse or
duplicate hostnames would otherwise let a second process "renew" someone else's
lease through the `holder = $me` branch.

Not gated: settlement's per-request `settleUser`. It is idempotent and
caller-scoped, and a follower serving a user's own portfolio must still settle
it.

## Rate limiting: the global bucket is only global because of one override

`services/api/src/common/throttling.ts`. `@nestjs/throttler` keys every bucket
**per handler** by default, so a single "300/min" throttler across ~40 routes is
a 12,000/min ceiling — i.e. none. `TradewThrottlerGuard.generateKey` drops the
handler from the `global` bucket's key and keeps it for `route`. That one
override is the entire mechanism; deleting it looks like a simplification and
silently removes the limit. Pinned by `throttling.spec.ts`.

Also: **counters are per-process.** Correct at one replica, wrong at two.
Deliberately not stubbed against Redis — a half-wired distributed limiter reads
as protection while providing none. Tracked as a Stage 1 prerequisite in
`docs/CLOUD-ARCHITECTURE.md`.

`TRUSTED_PROXY_HOPS` must equal the real hop count. `true` is worse than `0`: it
believes the whole `X-Forwarded-For` chain, so a client can prepend a fake
address and mint a fresh bucket per request.

## Numbers worth remembering

- **Sentinel: ~1.6 s p50 / 2.7 s p95 per observation** at 50 concurrent, market
  **closed**. That is ~300× a portfolio read (5 ms). Every sizing decision about
  the premium tier follows from it. Live-session runs do more work — treat this
  as a floor.
- **Saturation order at 1500 VUs:** the third-party crypto proxy fails first
  (6,770 × 503 from Binance pass-through at 45 rps), then Sentinel (7 s p50),
  then everything else's p95 while p50 stays fine — the classic queueing
  signature. TradeW's own code returned no 5xx at any point.
- **`ApiCallLog` grows ~500 bytes per request**, i.e. ~28 GB/month at the
  500-user target. Nothing bounded it before the 30-day retention sweep.

## Things that will bite the next agent

- **`prisma generate` fails with EPERM on Windows** while any service process
  holds `node_modules/.prisma/client/query_engine-windows.dll.node` — and the
  IDE respawns `nest --watch` immediately after you kill it. Workaround used
  here: `leader-election.ts` addresses `JobLease` entirely through raw SQL, so
  it compiles and runs against a client generated before the table existed.
  That is also the right thing on its own terms — leader election is
  infrastructure that must come up on a node whose client is a deploy behind.
- **Three duplicate `dev:api` watchers were running simultaneously**, which
  produced one genuinely confusing symptom: `npm test` reported 18 failures in
  `entitlements.spec.ts` that vanished on a targeted re-run. If a suite fails
  and then passes unchanged, count the watchers before debugging the test.
- **The order API takes `symbol`, not `instrumentId`** (`PlaceOrderDto` in
  `sim.controller.ts`). The first load run showed a 100% failure rate on the
  order path that was entirely the test sending the wrong shape — a load test
  that sends a rejected contract measures the validation pipe and reports it as
  a load result.
- **Load-testing against a rate-limited API measures the limiter.** All virtual
  users share one IP, so one bucket. The capacity runs used a second API
  instance on :4100 with limits raised — which incidentally proved leader
  election across two replicas.

## Deliberately not done

- Redis-backed rate limiting (Stage 1 prerequisite, application work).
- Making Sentinel horizontally scalable — its in-memory watch registry and its
  occurrence records feed **its own live-performance gate**, so two instances
  double-count into the gate that decides whether a pattern is proven. Pinned to
  one replica by a Terraform validation rule, not just a comment. Stage 2.
- Automating the daily Dhan token refresh (~15:21 IST). Highest-frequency source
  of user-visible breakage in the product, and it is an operational process, not
  a bug.
- Nonce-based CSP for `apps/web` (still `unsafe-inline`, honestly documented in
  `next.config.mjs`).

Related: [[Research/2026-08-10 - Offensive security assessment (auth-bypass class)]],
[[Plans/2026-07-17 - OCI Free Tier deployment]],
[[Patterns/2026-08-03 - Test infrastructure pass (runners made discoverable, money math covered)]].
