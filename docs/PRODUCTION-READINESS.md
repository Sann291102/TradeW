# TradeW Production Readiness Audit

**Date:** 2026-08-10
**Scope:** the whole repository — security, scalability, infrastructure, CI/CD,
data lifecycle — plus the fixes implemented during the audit.
**Companions:** `docs/LOAD-TEST-REPORT.md` (measured numbers),
`docs/CLOUD-ARCHITECTURE.md` (staged hosting plan).

---

## 1. The honest summary

**TradeW's application code is in better shape than its deployment path.** The
request-serving layer handled 500 concurrent users with p95 latencies in single
digits of milliseconds and no errors. Authentication, entitlements, order
matching, settlement and the Sentinel gates are real, tested, and behave
correctly under load.

**The production deployment, as it stood this morning, could not have been
built, let alone served a request.** Six independent defects, none of them
visible from a developer laptop, found by doing the two things nobody had done:
building the images, and reading what the containers actually contain.

| # | Defect | How it would have presented |
|---|---|---|
| 1 | `services/api`'s Dockerfile never built its workspace dependencies (`@tradew/types`, `@tradew/market-data`, `@tradew/ai-core`) | **`docker build` fails**, 15 TypeScript errors. The API image had never been built successfully. |
| 2 | `apps/web`'s Dockerfile never built `@tradew/types` | **`docker build` fails.** Same for the web image. |
| 3 | `.dockerignore` excluded all of `docs/`, but `apps/web` reads `docs/learning/` at build time | **`docker build` fails** — "Failed to collect page data for /learning/strategy/[id]". |
| 4 | The API container never set `HOST`; `main.ts` defaults to `127.0.0.1` | Container starts, logs look normal, **Caddy can never reach it**. |
| 5 | The live-feed bridge had no container, no compose entry and no CI job — while `apps/web` proxies `/feed/*` to it and Sentinel reads its `/candles` | `/feed/*` returns 502; **Sentinel silently degrades to stored, then simulated, data**. |
| 6 | Sentinel's citation corpus (`docs/Trading Books`, `knowledge/`, `knowledge-base/`, `agents/`, …) was excluded by `.dockerignore` and never copied into the image | **Completely silent.** Image builds, container starts, health check passes, corpus is empty. |

Defect 6 is the one worth dwelling on. Sentinel's citation guarantee is
*structural* — `VerdictBuilder.knowledge()` cannot be called without citations,
and the cross-checker drops uncited verdicts rather than flagging them — so an
empty corpus raises no error. It produces a Sentinel that never speaks, and
staying silent is a **designed, normal-looking outcome** of the publication
gate. The flagship premium feature would have shipped as a well-behaved no-op
and every signal would have said the system was healthy.

That gap — good code, unexercised deployment — is the single most useful finding
here, and it is the argument for the CI jobs added in §4. Defects 1–3 fail a
`docker build`, which now runs on every push. Defects 4–6 are configuration and
content, and were found by running the images and looking inside them; the fix
for each carries an inline comment saying what breaks if it is reverted, because
no test can see them.

All four images now build, run as an unprivileged user, and were verified to
contain what they need — including all six of Sentinel's corpus roots (14 books,
24 architecture docs, 28 handbook docs, 75 vault notes, 67 concept files, 4 agent
definitions).

Beyond that, the audit found and fixed a class of issue that only appears when
you try to run more than one copy of something: unbounded telemetry growth, no
rate limiting anywhere, no graceful shutdown, and background jobs that made a
second API replica a correctness hazard rather than a capacity decision.

### Where it stands now

| Area | Before | After | Notes |
|---|---|---|---|
| Auth & authorization | **Good** | **Good** | Hardened by the 2026-08-10 offensive pass; boot-time secret validation, constant-time service tokens, per-route guards. Nothing new found. |
| Rate limiting / abuse | **Absent** | **Good (single replica)** | Two-bucket limiter, strictest on credential and paid paths. Needs Redis before >1 replica. |
| Horizontal scalability | **Unsafe** | **Safe for `api`** | `JobLease` leader election. Sentinel and the ingestors remain singletons for stated reasons. |
| Deployment correctness | **Broken — images did not build** | **All four build and run** | Six defects fixed and verified by building and inspecting each image. Nothing has ever been deployed to a real host, so "unproven end to end" remains honest. |
| Data lifecycle | **Unbounded** | **Bounded** | 30-day telemetry retention. Was growing ~28 GB/month at target load. |
| Observability | **Partial** | **Partial** | Structured security logs and in-app telemetry are genuinely good. No tracing, no alerting. |
| Availability | **None** | **None** | Single VM, single database, 24-hour backup RPO. Deliberate at Stage 0. |
| Dependency hygiene | **16 advisories** | **16 advisories, now visible in CI** | All transitive; fixes need framework major bumps. |

---

## 2. What was implemented

Every item below is in the working tree, typechecks, and is covered by tests
where it has logic worth pinning. `services/api`: **274 tests passing**
(20 files, 26 new). `services/sentinel`: 297 passing. `apps/web`: 34.

### 2.1 Rate limiting — `services/api/src/common/throttling.ts` (new)

There was none. Concretely, that meant `POST /auth/login` accepted unlimited
guesses from one source; `/auth/signup`, `/auth/phone/request` and
`/auth/password/forgot` each spend a row, an SMS or an email per call with no
meter; and the unauthenticated market proxies could be looped by anyone.

Two named buckets, both measured on every request:

- **`global`** — keyed by caller only, so it is a genuine ceiling across the
  whole API (300/min default). `@nestjs/throttler` keys per-handler by default,
  which would have made "300/min" mean "300/min × 40 routes"; the override that
  prevents this is the whole mechanism and is pinned by a test.
- **`route`** — keyed by caller *and* handler, inert by default (240/min) and
  tightened per route: **8/min** on credential endpoints, **3/min** on anything
  that sends a message, **60/min** on the public proxies, **30/min** on
  `/sentinel/*`.

The Sentinel limit is not redundant with the plan quota. The quota is a monthly
commercial ceiling; this is an operational per-minute one. Without it, a client
in a retry loop spends a day's quota in under a minute and takes the reasoning
tier down for everyone on the way.

Probe paths (`/health`, `/ready`, `/live`) are exempt — a 429 on a health check
during a traffic spike restarts the instance at exactly the wrong moment.

**Verified:** 8 logins pass, the 9th through 12th return 429, `/health` stays
200 throughout (`docs/LOAD-TEST-REPORT.md` §5).

**Known limit, stated rather than hidden:** counters live in process memory.
Correct for one replica, wrong for two. `docs/CLOUD-ARCHITECTURE.md` tracks the
Redis swap as a Stage 1 prerequisite. It is not stubbed in code because a
half-wired distributed limiter reads as protection while providing none.

### 2.2 Real client IP — `TRUSTED_PROXY_HOPS`

Rate limiting and the security audit log both read `req.ip`. Behind a proxy,
Express reports the *proxy's* address unless told how many hops to trust — so
without this the entire internet would share one rate-limit bucket and every
login attempt would be logged as coming from Caddy.

Set to the real hop count, never `true`: trusting the whole `X-Forwarded-For`
chain lets a client prepend a fabricated address and mint a fresh bucket per
request. Defaults to `0`; compose sets `1`.

### 2.3 Leader election — `services/api/src/common/leader-election.ts` (new)

**The most consequential change here.** Five background loops ran on plain
`setInterval`, each written as if it were the only copy. With two API replicas,
two matching engines can independently read the same resting order as unfilled,
price it, and fill it — a duplicated position on a real user's book. Horizontal
scaling was gated on a *correctness* property, which is the wrong shape for a
scaling decision to have.

A `JobLease` table (new migration `20260810120000_job_lease`) holds a
time-bounded claim per named job. A single `INSERT … ON CONFLICT … WHERE
expiresAt < NOW() OR holder = $me RETURNING` does acquisition and renewal
atomically, with **Postgres's** clock deciding, not the caller's.

Two design points worth stating because both are easy to get wrong:

- **A lease, not a `pg_advisory_lock`.** Session advisory locks live on a
  specific connection, and Prisma pools connections — the lock's owner and the
  next caller are usually different sessions, and behind PgBouncer in
  transaction mode they do not survive at all. The transaction-scoped variant
  does, but would hold a transaction open for an entire matching-engine tick,
  which makes outbound HTTP calls.
- **`isLeader()` is local and synchronous, and checks an EXPIRY.** A paused or
  partitioned process cannot distinguish "I am still leader" from "my lease
  lapsed 30 seconds ago" — so it answers false the moment its own last-confirmed
  deadline passes, whether renewal failed or the database is simply unreachable.
  Losing leadership is fail-safe; keeping it wrongly is not.

Gated: `matching-engine`, `settlement-sweep`, `performance-snapshot-sweep`,
`telemetry-retention`. Deliberately **not** gated: settlement's per-request
`settleUser`, which is idempotent and caller-scoped — a follower serving a
user's own portfolio must still be able to settle it.

**Verified live** with two API instances against one database: all four leases
held by one process, the second acquiring none, both serving HTTP
(`docs/LOAD-TEST-REPORT.md` §4). 13 tests.

### 2.4 Liveness vs readiness — `services/api/src/health.controller.ts`

One endpoint answered both questions and therefore answered neither:

- A container with an unreachable database reported healthy, so a rolling deploy
  would shift traffic onto it and every DB-backed route would 500.
  `PrismaService` deliberately boots through a database outage — which is right,
  and is exactly why "started" and "can serve" have to be separate signals.
- A slow database would fail a *liveness* probe and get the container killed,
  turning a recoverable dependency problem into a restart loop.

Now: `/live` touches nothing; `/ready` runs `SELECT 1` through the real pool
with a 2-second timeout and returns **503** when it fails; `/health` is retained
verbatim as the liveness alias because existing compose healthchecks, the OCI
runbook and deploy tooling already call it.

The ALB target group health-checks `/ready`; container health checks use
`/health`. That split is the point.

### 2.5 Graceful shutdown

`app.enableShutdownHooks()` was missing in all three services, and every deploy
sends SIGTERM. Without it Nest skips `OnModuleDestroy`, which meant: up to 2
seconds of buffered API/AI/agent telemetry discarded per deploy, Prisma sockets
torn down by the OS instead of disconnected, job leases held until expiry
instead of released, and — in `market-data` — a broker feed socket left to be
reaped on timeout, which on a provider that counts five connections per account
can cost the next process its slot.

`tini` added to all four Dockerfiles for the same reason one layer down: Node as
PID 1 gets no default signal handlers, so an unhandled SIGTERM is *discarded*
and `docker stop` waits out its grace period and then SIGKILLs.

### 2.6 Telemetry retention

Every HTTP request writes an `ApiCallLog` row. The in-memory buffers were
bounded from the start; the tables were not.

Measured on this machine after the load runs: **146,138 rows / 70 MB**, about
500 bytes a row. At the 500-user target's sustained 85 rps over a 6.25-hour
trading day that is ~1.9M rows/day — roughly **28 GB/month**, on the same
Postgres instance serving orders and positions.

Hourly leader-gated sweep, 30-day window, batched `DELETE … WHERE ctid IN
(SELECT … LIMIT 20000)` so one sweep after a backlog cannot hold locks long
enough to stall the flush serving live traffic. 30 days matches what the admin
portal actually reads — its views are day- and week-scoped.

### 2.7 Container hardening

All four images: non-root (`USER node`), `tini` as init, a baked-in
`HEALTHCHECK`. Until now every service ran as **root**, so a remote-code-execution
bug anywhere in ~1,000 transitive dependencies would have started with root
inside the container. Nothing needs it — the processes bind unprivileged ports,
read their own tree, and write nothing.

Also fixed: `apps/web`'s image never copied `feed-proxy-routes.mjs`, which
`next.config.mjs` imports at server start. The production Next server could not
have loaded its own config — a bug no local run could surface, because locally
the file is simply there.

### 2.8 Deployment fixes

The six defects in §1, plus:

- **`.dockerignore` now distinguishes documentation from application content.**
  `docs/learning` (the web build reads it), `docs/Trading Books`,
  `docs/product-architecture`, `docs/handbook` and `knowledge/**` (Sentinel's
  corpus roots) are re-included with an explanation of what breaks without each.
  ~30 MB of that is the book PDFs, which earn it: they *are* Sentinel's
  knowledge base.
- **`services/sentinel/Dockerfile` copies all six corpus roots** and creates a
  writable `data/` directory for the index it produces.
- **`live-feed` is now a compose service** built from the market-data image,
  with the bridge's sources and `tsconfig.scripts.json` shipped alongside.
- **`sentinel` gets `SENTINEL_LIVE_FEED_URL`, `web` gets `API_PROXY_TARGET` and
  `FEED_PROXY_TARGET`, `api` gets `HOST` and `TRUSTED_PROXY_HOPS`** — every one
  of these previously fell back to a localhost default that means "myself"
  inside a container.
- **The Caddyfile carries a standing warning** against adding a `/feed/*` route.
  Routing the bridge directly at the edge would bypass `apps/web`'s allowlist
  and republish every route the unauthenticated bridge has — the exact
  structural defect the allowlist exists to prevent.

Detail in `docs/CLOUD-ARCHITECTURE.md` §1.

---

## 3. What each user flow can reliably support

Ratings are against the 500-concurrent target on the **Stage 0** single-VM
deployment. "Reliably" means: it works, it is metered, its failure mode is
understood, and the audit has evidence rather than an opinion.

| Flow | Rating | Measured | The honest caveat |
|---|---|---|---|
| **Sign up / log in** | 🟢 | p50 <10 ms | Rate-limited at 8/min per IP. Password auth only — Google OAuth and phone are code-complete but **unconfigured** (`/auth/methods` returns `google:false, phone:false`). |
| **Password reset** | 🟡 | — | Fully implemented, **but SMTP is unset in this environment**, so codes go to the console instead of an inbox. Configure SMTP or the flow is a dead end for a real user. |
| **Dashboard / live board** | 🟢 | 37.5 rps, p95 10.3 ms | The most-hit path in the product and the cheapest. Comfortable headroom. |
| **Portfolio, positions, holdings, trade history** | 🟢 | p95 8–10 ms each | Least cacheable work in the app (all user-scoped) and still cheap. 75 schema indexes doing their job. |
| **Place / cancel orders** | 🟢 | p50 21 ms, p95 37 ms | Most expensive owned write, still fast. Now safe with >1 API replica — it was not before §2.3. |
| **T+1 settlement, EOD snapshots** | 🟢 | — | Leader-gated; runs exactly once regardless of replica count. |
| **Learning platform** | 🟢 | p95 10–15 ms | Read-heavy, highly cacheable, entitlement-gated. No concerns. |
| **News, crypto, FX, US stocks** | 🟡 | crypto p95 341 ms, max 1.2 s | Third-party latency, not TradeW's. Server-side cached so cost does not scale with users — but a vendor slowdown is directly visible on the dashboard, and there is no explicit degrade path. |
| **Sentinel observation / reasoning** | 🟡 | **p50 1.63 s, p95 2.67 s** at 50 concurrent | Works, zero errors, correctly gated. But 300× a portfolio read, capacity-capped at one replica, and these are *market-closed* numbers — live sessions do more work. Size the premium tier around this, not around the API. |
| **Live market data (Dhan feed)** | 🟠 | — | The weakest link, and not for capacity reasons. Single ingestor by external constraint (5 connections/account), **the access token expires daily (~15:21 IST) and is refreshed manually**, and the bridge has no authentication of its own. A working day currently depends on someone running a token refresh. |
| **Admin portal** | 🟡 | — | Double-gated (session + operator token) and correct. The SSE stream has no connection cap; fine for a handful of operators, not a public surface. |
| **Knowledge workspace** | 🟢 | — | Now mounted under `/admin/knowledge` behind both guards. The earlier unauthenticated exposure is closed. |

**Overall:** at 500 concurrent users, everything except Sentinel and the live
feed is comfortable, and the two exceptions are understood rather than
mysterious.

---

## 4. CI and delivery

Added to `.github/workflows/ci.yml`:

- **Migration drift** — applies every migration to a real Postgres from scratch,
  then asserts `prisma migrate diff` is empty. A `schema.prisma` edited without
  a migration typechecks and tests green, then fails on the production
  `migrate deploy` — or worse, succeeds against a database that has silently
  drifted.
- **Docker image builds** for all four images. Every one of the three deployment
  defects in §1 would have failed here first.
- **Compose config validation** for both stacks.
- **Dependency audit** — reports everything, fails only on `critical`.
  Deliberate: a blocking gate fails the day an unfixable transitive advisory
  lands, gets disabled, and then nobody is looking at all. Standing state is 16
  findings (9 moderate, 7 high), all transitive — `postcss` via `next`, `qs` via
  `express` — each needing a framework major bump.
- **Terraform fmt + validate**, running without credentials.

Pre-existing and unchanged: test suites, and typechecks for api / sentinel /
market-data / web.

---

## 5. What is still open

Ordered by what would actually hurt first.

**1. Nothing has ever been deployed.** Every fix above is reasoned and locally
verified; none has survived contact with a real VM. The first deploy is the real
test, and it should happen soon precisely because it is now likely to succeed.

**2. The Dhan token expires daily and is refreshed by hand.** This is the
highest-frequency source of user-visible breakage in the product and it is an
operational process, not a bug. Automate the refresh or alert on its absence —
right now the failure mode is Sentinel quietly reading stale data.

**3. Rate-limit counters are per-process.** Blocks `api_desired_count > 1` from
meaning what it says. Redis is provisioned at both stages; the wiring is
application work.

**4. Sentinel cannot scale horizontally.** In-memory watch registry plus
occurrence records that feed its own live-performance gate — two instances
double-count into the gate that decides whether a pattern is proven. Stage 2
work, scoped in `docs/CLOUD-ARCHITECTURE.md` §4.

**5. No alerting.** The observability that exists is genuinely good at
after-the-fact investigation and has no way to wake anyone up. The single
highest-value addition is an alert on `/ready` failing — that endpoint now knows
the difference between "alive" and "can serve", and nothing is watching it.

**6. No third-party degrade path.** `/crypto/quotes` at a 1.2-second worst case
is a vendor problem today and a support ticket the day the vendor is down.
Explicit timeout plus last-known-good would make it a stale badge instead of a
spinner.

**7. Backups are a 24-hour RPO** via nightly `pg_dump`, and the cron is
documented but installed by hand on the VM. Fine for simulated portfolios;
revisit before anything is transacted.

**8. SMTP unconfigured**, so password reset cannot complete for a real user in
this environment.

**9. 16 dependency advisories**, all transitive, all needing framework major
bumps. Now visible in CI rather than discovered during an incident.

**10. `apps/web` still ships `unsafe-inline` in its CSP.** Pre-existing,
honestly documented in `next.config.mjs`, and a real piece of work (nonce-based
CSP across every page) rather than a flag.

---

## 6. Reproducing the evidence

```bash
npm test
npx tsc --noEmit -p services/api/tsconfig.json
docker compose -f infra/docker/docker-compose.prod.yml --env-file infra/docker/.env.prod.example config
node scripts/loadtest/run.mjs --vus 500 --ramp 60 --hold 180 --mix full
```

Terraform validates without credentials:

```bash
terraform -chdir=infra/terraform init -backend=false && terraform -chdir=infra/terraform validate
```
