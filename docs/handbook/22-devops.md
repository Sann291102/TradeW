# Chapter 22 — DevOps

**Status: 🟡.** The production stack is fully designed and written — Dockerfiles, production compose, Caddy with automatic TLS, a backup script with retention, and a CI/CD workflow. **It has never been provisioned or deployed.** Everything in this chapter is real code that has never met reality.

---

## 22.1 The deployment target

**A single Oracle Cloud Ampere A1 VM (arm64), OCI Free Tier.**

| | |
|---|---|
| Shape | Ampere A1 (arm64) |
| Region | Mumbai (⚖️ NFR-C5 data residency) |
| Public surface | one reverse proxy, ports 80/443 only |
| Everything else | an internal Docker network |
| Cost | ₹0 on Free Tier |

### 22.1.1 Why one VM and not Kubernetes

`infra/k8s/` and `infra/terraform/` exist as README-only folders, deliberately.

| | Single VM + compose | Kubernetes |
|---|---|---|
| Operational surface | one host, one compose file | control plane, manifests, ingress, secrets, RBAC, an operator |
| Cost | ₹0 | ₹15,000+/month minimum |
| Time to first deploy | hours | weeks |
| Scales to | ~5,000 concurrent | ~unbounded |
| Debuggability | `docker compose logs` | `kubectl` archaeology |

Principle 7: **the trigger for Kubernetes is load a single VM demonstrably cannot serve, not a feeling that a real company runs Kubernetes.** The compose file's service topology maps one-to-one onto Deployments when that day comes, so the migration is mechanical rather than a redesign.

---

## 22.2 Containers

### 22.2.1 The production stack

```
                        Internet
                           │  :80 :443
                    ┌──────▼──────┐
                    │    caddy    │  ← the ONLY public service
                    │  auto-TLS   │
                    └───┬─────┬───┘
                        │     │  /api/* (prefix stripped)
              ┌─────────▼─┐ ┌─▼──────────────┐
              │    web    │ │      api       │
              │ Next :3000│ │  NestJS :4000  │
              └───────────┘ └──┬──────┬──────┘
                               │      │
                     ┌─────────▼──┐ ┌─▼──────────────┐
                     │  sentinel  │ │   postgres     │
                     │   :4010    │ │  pgvector:pg16 │
                     │ (internal) │ └────────────────┘
                     └────────────┘
                     ┌────────────┐ ┌────────────────┐
                     │   redis    │ │    migrate     │
                     │(provisioned│ │  (one-shot,    │
                     │ not yet    │ │   run-to-      │
                     │  consumed) │ │   completion)  │
                     └────────────┘ └────────────────┘

                  all on the internal `tradew` network
```

### 22.2.2 What the compose file gets right

```yaml
name: tradew
x-restart: &restart
  restart: unless-stopped

services:
  caddy:
    ports: ['80:80', '443:443']       # ← the ONLY published ports
  web:
    expose: ['3000']                  # ← expose, not ports: internal only
  api:
    expose: ['4000']
    depends_on:
      migrate:  { condition: service_completed_successfully }
      sentinel: { condition: service_started }
```

| Decision | Why it matters |
|---|---|
| **`expose:` not `ports:`** for everything but Caddy | 🔒 A published port is internet-reachable. Only the proxy is. |
| **`depends_on: migrate: service_completed_successfully`** | The API cannot start against an un-migrated database. Not a race, a dependency. |
| **YAML anchor for `restart`** | One place to change restart policy |
| **`image:` with a `build:` fallback** | The same file pulls in production and builds on the VM for debugging |
| **Redis provisioned but unconsumed** | The infrastructure is ready before OPS-1 and SEC-4 need it |
| **Sentinel not routed by Caddy** | 🔒 ARCH-1 enforced at the network layer, not just in code |

That last one is the strongest control in the file: **Sentinel is unreachable from the internet by topology.** Even a bug in `ServiceTokenGuard` would not expose it.

### 22.2.3 🔵 Container hardening

Not yet applied:

```
   □ non-root USER in every Dockerfile
   □ minimal base (distroless or alpine)
   □ pinned base image digests, not floating tags
   □ read-only root filesystem where possible
   □ per-container memory and CPU limits
   □ no Docker socket mounted anywhere
   □ multi-stage builds — no build toolchain in the runtime image
   □ HEALTHCHECK in every image
```

Memory limits matter more than they look on a Free Tier VM: one container leaking memory takes down the host and therefore every other container.

---

## 22.3 CI/CD

### 22.3.1 The pipeline today

```yaml
on:
  push:
    branches: [main]
    paths: ['apps/web/**','services/**','packages/**','infra/docker/**','.github/workflows/deploy.yml']

env:
  PLATFORMS: linux/arm64          # ← OCI Ampere A1 is arm64

jobs:
  build:
    strategy:
      matrix:
        include:
          - { name: web,      dockerfile: apps/web/Dockerfile }
          - { name: api,      dockerfile: services/api/Dockerfile }
          - { name: sentinel, dockerfile: services/sentinel/Dockerfile }
    steps:
      - setup-qemu-action          # arm64 emulation on amd64 runners
      - setup-buildx-action
      - login to ghcr.io           # GITHUB_TOKEN, no extra secret
      - build-push-action
          tags: ghcr.io/<owner>/tradew-<name>:latest
                ghcr.io/<owner>/tradew-<name>:${{ github.sha }}
          cache-from/to: type=gha

  deploy:
    needs: build
    - ssh:
        cd /opt/tradew && git pull --ff-only
        $COMPOSE pull
        $COMPOSE run --rm migrate
        $COMPOSE up -d
        docker image prune -f
```

### 22.3.2 What it gets right

| Decision | Why |
|---|---|
| **Path-triggered** | a docs change does not rebuild three images |
| **Matrix build** | three images in parallel |
| **Tagged `:latest` AND `:${sha}`** | every deploy is identifiable and rollback-able |
| **GHA layer cache** | a rebuild is minutes, not tens of minutes |
| **`GITHUB_TOKEN` for ghcr.io** | no extra secret to manage or rotate |
| **Migrations before `up -d`** | fails loudly, independently, before any app starts |
| **`git pull --ff-only`** | a divergent VM state fails rather than merging |

### 22.3.3 🔴 What it does not do

```
   ✅ build   ✅ push   ✅ deploy
   ❌ tests            (none exist — TEST-3)
   ❌ lint             (no ESLint config — TD-3)
   ❌ typecheck        (only implicit inside each build)
   ❌ npm audit        (SEC-6)
   ❌ secret scanning  (SEC-13)
   ❌ image scanning
   ❌ ⚖️ compliance-language suite
   ❌ bundle budget
   ❌ smoke test after deploy
   ❌ automatic rollback on failure
```

> **This is a deploy pipeline, not a CI pipeline.** A commit that breaks every endpoint deploys successfully.

### 22.3.4 🔵 The pipeline that should exist

```
   ┌─ PR ───────────────────────────────────────────────────┐
   │ typecheck · lint · unit · ⚖️ compliance · integration   │  blocking
   │ npm audit high+ · gitleaks · bundle budget             │  blocking
   │ lighthouse · coverage delta · benchmarks               │  warning
   └────────────────────────────────────────────────────────┘
                            │ merge to main
   ┌─ BUILD ────────────────▼───────────────────────────────┐
   │ matrix build arm64 · Trivy image scan · push :sha       │
   └────────────────────────┬───────────────────────────────┘
   ┌─ DEPLOY ───────────────▼───────────────────────────────┐
   │ pre-migration DB snapshot                               │
   │ run migrations (one-shot)                               │
   │ deploy · wait for health                                │
   │ SMOKE TEST  ── fail? ──► automatic rollback to prev :sha │
   │ tag the release                                          │
   └─────────────────────────────────────────────────────────┘
```

**The smoke test and the automatic rollback are the two most valuable additions.** Without them, a deploy that starts healthy containers serving 500s is indistinguishable from a successful deploy.

---

## 22.4 TLS and routing

```caddy
{ email {$ACME_EMAIL} }

{$DOMAIN} {
	encode zstd gzip

	handle_path /api/* {
		reverse_proxy api:4000 {
			flush_interval -1     # ← SSE needs unbuffered streaming
		}
	}

	handle { reverse_proxy web:3000 }
}
```

### 22.4.1 Three good decisions in twelve lines

**1. Automatic HTTPS.** Let's Encrypt certificates issued and renewed by Caddy with zero configuration. Certificate expiry — a classic 3 a.m. outage — simply does not occur.

**2. Same-origin routing removes CORS entirely.**

```
   browser → https://app.tradew.com/api/auth/login
   Caddy handle_path strips /api → api:4000/auth/login
```

The browser makes a same-origin request. No preflight, no CORS headers, no cookie `SameSite` complications. The `enableCors` configuration in `main.ts` exists for local development, where the dev server runs on a different port.

**3. `flush_interval -1` for SSE.** A buffering proxy silently breaks Server-Sent Events — the connection opens, the client waits, and nothing arrives until the buffer fills. It is a genuinely hard bug to diagnose and it is prevented here by one line. It is also what makes the specified push architecture (Chapter 16 §16.11) work when it lands.

### 22.4.2 🔵 Missing security headers

Chapter 19 §19.10.1. Five headers in this file — CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` — close the entire clickjacking and content-sniffing category for about thirty minutes of work.

---

## 22.5 Backups

**Code:** `infra/docker/backup.sh`

```bash
# Nightly pg_dump (compressed), uploaded via rclone, with retention pruning.
# Cron: 30 2 * * * cd /opt/tradew && ./infra/docker/backup.sh >> /var/log/tradew-backup.log 2>&1
#
# Restore:
#   rclone copy $REMOTE:$BUCKET/tradew-YYYYMMDD-HHMMSS.sql.gz .
#   gunzip -c tradew-*.sql.gz | docker compose … exec -T postgres psql …

set -euo pipefail
```

### 22.5.1 What it gets right

| | |
|---|---|
| `set -euo pipefail` | fails on any error, unset variable, or pipe failure — a backup script that continues after a failure is worse than none |
| `${VAR:?message}` for required config | fails immediately with a readable message |
| **Restore instructions in the file itself** | ⭐ the restore procedure is where you need it at 3 a.m. |
| Retention pruning | 14 days by default |
| Off-host storage | OCI Object Storage via rclone |
| Compressed | `pg_dump | gzip` |

The restore instructions being in the script is a small thing that matters enormously. The alternative is a wiki page nobody can reach during the outage that requires the restore.

### 22.5.2 🔴 The gap that invalidates all of it

> **This backup has never been restored.**

Chapter 17 §17.9.4: a backup that has never been restored is not a backup, it is a file. The quarterly restore drill is not optional, and the first one must happen before the first user.

### 22.5.3 🔵 Missing backup layers

| Layer | Status | Gap |
|---|---|---|
| Nightly logical dump | 🟢 written | never verified |
| Continuous WAL archiving | 🔵 | **RPO is currently 24 hours, not 5 minutes** |
| Weekly cross-region | 🔵 | region loss = total loss |
| ⚖️ Monthly object-locked | 🔵 | no ransomware-proof copy |
| Pre-migration snapshot | 🔵 | a bad migration has no fast undo |

**WAL archiving is the priority.** Without it, a failure at 01:59 loses the entire trading day.

---

## 22.6 Environments

| Tier | Infrastructure | Secrets | Market data | Status |
|---|---|---|---|---|
| **local** | `docker compose up` | `.env` files | OU simulator | 🟢 |
| **staging** | (specified) same compose, separate VM/domain | secrets manager | Dhan sandbox | 🔵 |
| **production** | OCI Ampere A1 | secrets manager | Dhan live | 🔵 never provisioned |

### 22.6.1 🔵 Staging is not optional

There is no staging environment. Consequences:

- Migrations are first executed against production
- The full deploy path is never rehearsed before it matters
- Load testing has nowhere to run
- ⚖️ The compliance-language nightly run against a live model has nowhere to run
- Chaos experiments (Chapter 21 §21.10) have nowhere to run

**Staging is the same compose file on a second VM with a separate domain and database.** It is roughly one day of work and it removes an entire category of production-first surprises.

### 22.6.2 ⚠️ The local compose is not a production baseline

```yaml
POSTGRES_PASSWORD: tradew          # development only
PGADMIN_DEFAULT_PASSWORD: admin    # development only
ports: ['5433:5432']               # must NEVER be published in production
```

pgAdmin must not run in production at all. `docker-compose.yml` and `docker-compose.prod.yml` are different files for exactly this reason; using the wrong one is catastrophic and easy.

---

## 22.7 Monitoring and observability 🔵

**Nothing exists.** No metrics, no dashboards, no alerts, no log aggregation, no tracing.

### 22.7.1 The build order

`ARCHITECTURE.md` §8, cheapest leverage first — the ordering principle matters as much as the list, because a plan that starts with a full ELK stack ends with no logging at all:

| # | Capability | Effort | Value |
|---|---|---|---|
| 1 | **Structured JSON logging** | low | immediate debugging |
| 2 | **Prometheus + Grafana** | medium | p50/p95/p99 per endpoint |
| 3 | **One Slack alert webhook** | low | you find out before the user tells you |
| 4 | **OpenTelemetry tracing** | high | one order's full path |
| 5 | **Loki log aggregation** | medium | search across services |

> *"Don't stand up PagerDuty-style paging before there's an on-call rotation to page."*

### 22.7.2 The first dashboard

```
   ┌─ SERVICE HEALTH ────────────────────────────────────────┐
   │ up/down per service · restart count · memory · CPU      │
   ├─ REQUESTS ──────────────────────────────────────────────┤
   │ rate · error rate · p50/p95/p99 by route                │
   ├─ DATABASE ──────────────────────────────────────────────┤
   │ connections · slow queries · size · replication lag      │
   ├─ TRADING ───────────────────────────────────────────────┤
   │ orders/min by type · fill rate · resting orders ·        │
   │ matching tick duration                                   │
   ├─ SENTINEL ──────────────────────────────────────────────┤
   │ observe rate · ⭐ SURFACE RATE · LLM fallback rate ·      │
   │ ⚖️ audit write failures                                  │
   ├─ MARKET DATA ───────────────────────────────────────────┤
   │ feed status · ticks/sec · reconnects · rate-limit budget │
   └─────────────────────────────────────────────────────────┘
```

**Surface rate** (Chapter 9 §9.7.3) is the only product metric on an engineering dashboard, and it belongs there: it is the number that tells you whether Sentinel has become a noise generator.

### 22.7.3 Alert policy

| Alert | Threshold | Action |
|---|---|---|
| ⚖️ audit write failures | > 0 | **page** |
| API 5xx rate | > 1% for 5 min | **page** |
| Postgres unreachable | any | **page** |
| Market feed down in session | > 60 s | **page** |
| Disk > 85% | — | **page** |
| Certificate expiry | < 7 days | page (Caddy makes this unlikely) |
| Matching tick failures | > 10% for 5 min | ticket |
| API p95 | > 500 ms for 10 min | ticket |
| Sentinel fallback rate | > 20% | ticket |
| Surface rate | > 25% or < 2% | ticket |

**Only five page.** Everything else degrades gracefully. An alerting policy that pages for degradation trains people to ignore pages, which is worse than having no alerts.

---

## 22.8 Deployment strategies

### 22.8.1 Today: rolling restart with downtime

```bash
$COMPOSE pull && $COMPOSE run --rm migrate && $COMPOSE up -d
```

`up -d` recreates changed containers. **There is a short window where the API is down.** Acceptable pre-launch; not acceptable during market hours.

### 22.8.2 🔵 Blue-green on one VM

```
   ┌─────────── Caddy ───────────┐
   │  upstream = api-blue:4000   │  ← flip this line, reload Caddy
   └──────┬──────────────┬───────┘
          │              │
   ┌──────▼─────┐ ┌──────▼─────┐
   │  api-blue  │ │ api-green  │
   │  (live)    │ │ (new, warm)│
   └────────────┘ └────────────┘

   1. deploy green alongside blue
   2. wait for green's healthcheck
   3. smoke test green DIRECTLY (bypassing Caddy)
   4. flip the Caddy upstream; caddy reload (zero-downtime)
   5. keep blue running for 10 minutes
   6. rollback = flip back  ← seconds, not a redeploy
```

**Rollback in seconds by flipping one config line** is the property that makes deploying during market hours defensible.

### 22.8.3 🔵 Canary

Caddy can weight upstreams. 5% → 25% → 100% with automated rollback on error-rate breach. Worth it once there is enough traffic for 5% to be statistically meaningful — not before.

### 22.8.4 ⚠️ Migration compatibility is the real constraint

Blue-green means **both versions run simultaneously against one database.**

```
   ❌ DROP COLUMN in the same release that stops using it
        → blue is still reading it. Instant errors.

   ✅ Release N   : add the new column (nullable), dual-write
      Release N+1 : switch reads to the new column
      Release N+2 : stop writing the old column
      Release N+3 : drop the old column
```

Four releases to rename a column. That is not bureaucracy — it is the price of never taking the API down, and it is the single most common way a zero-downtime deploy strategy is defeated by a migration.

---

## 22.9 Feature flags 🔵

**None exist.** Needed for: shipping incomplete work behind a flag, canarying by user, kill-switching an expensive AI path, and ⚖️ disabling a surface if a compliance concern emerges.

### 22.9.1 The design

```prisma
model FeatureFlag {          // 🔵
  key         String  @unique     // 'sentinel_streaming'
  enabled     Boolean @default(false)
  rolloutPct  Int     @default(0)
  userIds     String[]            // explicit allowlist
  description String
  updatedBy   String              // ⚖️ audited
  updatedAt   DateTime
}
```

**Reuse the entitlement pattern:** one service decides, one guard enforces, decisions are cached briefly with an explicit bust. ⚖️ Every flag change writes an `AuditEvent` — a flag flip is a production change and must be as traceable as a deploy.

### 22.9.2 Flag hygiene

```
   □ Every flag has an owner and a removal date at creation
   □ A flag at 100% for 30 days is DELETED, not left in place
   □ Never nest flags — 2^n paths, none of them tested
   □ ⚖️ A kill-switch flag is tested in staging before it is needed
```

---

## 22.10 n8n and operations automation 🔵

**Genesis Phase 11.** `workflows/` holds versioned JSON exports; n8n itself stays out-of-tree as a third-party dependency.

### 22.10.1 The direction of calls

```
   TradeW → n8n   a service calls an n8n webhook to TRIGGER a workflow
                  (e.g. notification on OrderFilled, api on signup)

   n8n → TradeW   a running workflow calls back into services/api using a
                  SERVICE-SCOPED credential (never an end-user JWT)
```

### 22.10.2 ⚠️ The hard boundary

> **Nothing on the sub-150 ms path — market ticks, order execution — ever routes through n8n.** It is for minutes-scale ops workflows, never the trading hot path.

And from the constitution: **n8n orchestrates agents; it does not contain business logic.** Reasoning lives in `services/tradew-ai` and `services/sentinel`, never baked into an n8n node. n8n is coordination, never the brain.

### 22.10.3 Why the exports are in git

> *"Exporting them into git means workflow changes go through code review and CI deployment instead of being edited invisibly in a running n8n UI."*

An ops automation edited live in a UI is an undocumented, unreviewed, unrevertable production change. Versioning the exports makes it a pull request.

---

## 22.11 Runbooks 🔵

Appendix E will hold the full set. The ones that must exist before the first deployment:

```
   □ Deploy a release
   □ Roll back a release
   □ Restore the database from backup          ← rehearse quarterly
   □ Rotate JWT_SECRET / SERVICE_TOKEN / DB credentials
   □ Rotate the Dhan access token (24-hour expiry!)
   □ Respond to "the market feed is down"
   □ Respond to "the API is returning 500s"
   □ Respond to "Postgres is out of disk"
   □ ⚖️ Respond to a suspected data breach
   □ Scale up the VM
   □ Add a new service to the stack
```

### 22.11.1 The runbook standard

```
   TITLE          what this fixes
   SYMPTOMS       what you will see (alert text, log lines, user reports)
   SEVERITY       and who to notify
   PREREQUISITES  access, credentials, tools
   STEPS          numbered, copy-pasteable, with expected output at each step
   VERIFICATION   how you know it worked
   ROLLBACK       what to do if the fix makes it worse
   ESCALATION     who to call and when to stop trying
```

> **A runbook that requires thinking is a design document.** The point is that it works at 3 a.m., for someone who did not write the system, under pressure.

---

## 22.12 The pre-deployment checklist

Nothing goes to production until every box is ticked.

```
   ─ SECURITY (Chapter 19) ────────────────────────────────
   □ SEC-0  Neon credential confirmed rotated
   □ SEC-3  RBAC implemented — admin endpoints protected
   □ SEC-4  Rate limiting on /auth/login and the API
   □ SEC-6  Dependabot + npm audit in CI
   □ SEC-7  Security headers in the Caddyfile
   □ SEC-8  ⚖️ Incident-response plan written
   □ Full git-history secret scan completed

   ─ RELIABILITY ──────────────────────────────────────────
   □ OPS-1  Matching-engine leader lock (or single replica enforced)
   □ Backup restore DRILLED and timed          ← DB-4
   □ WAL archiving configured                  ← RPO 5 min, not 24 h
   □ Health checks on every service
   □ Container memory limits set

   ─ OBSERVABILITY ────────────────────────────────────────
   □ Structured JSON logging
   □ Prometheus + one dashboard
   □ The five paging alerts wired to a real destination
   □ ⚖️ Audit-write-failure alert verified by inducing one

   ─ QUALITY (Chapter 21) ─────────────────────────────────
   □ CI runs tests and blocks on failure
   □ ⚖️ Compliance-language suite at 100%
   □ Coverage ≥ 70%
   □ MVP-loop E2E passing

   ─ OPERATIONS ───────────────────────────────────────────
   □ Staging environment exists and mirrors production
   □ The migration path rehearsed on staging
   □ Rollback rehearsed
   □ Runbooks written for all 11 scenarios
   □ Someone is actually on call, and knows they are
```

---

## 22.13 DevOps debt

| ID | Item | Severity | Effort |
|---|---|---|---|
| **OPS-5** | **Never deployed** | **critical** | 2 days |
| **OPS-6** | **No staging environment** | **critical** | 1 day |
| **OPS-7** | **Backup never restored** (DB-4) | **critical** | 4 hours |
| ~~OPS-8~~ | ~~CI runs no tests (TEST-3)~~ — **resolved**: `ci.yml` runs typecheck + tests | ✅ |
| OPS-9 | No monitoring or alerting | **high** | 3 days |
| OPS-1 | No matching-engine leader lock | high | 2 hours |
| OPS-10 | No WAL archiving — RPO is 24 h | high | 4 hours |
| OPS-11 | No smoke test or auto-rollback | high | 1 day |
| OPS-12 | No blue-green — deploys have downtime | medium | 1 day |
| OPS-13 | Containers not hardened | medium | 1 day |
| OPS-14 | No feature flags | medium | 2 days |
| OPS-15 | No runbooks | medium | 2 days |
| OPS-16 | `services/market-data` absent from the CI matrix | medium | 2 hours |
| OPS-17 | No cross-region or object-locked backup | medium | 4 hours |

### 22.13.1 The honest summary

The infrastructure is **well designed and completely untested.** Caddy's same-origin routing removes CORS, `flush_interval -1` pre-empts an SSE bug that has not happened yet, migrations gate the API's start, only the proxy is public, and the backup script carries its own restore instructions. These are the decisions of someone who has operated systems before.

None of it has run. Every one of those decisions is a hypothesis until the first deployment, and the gap between "the compose file is correct" and "the system runs" is where DevOps actually lives.

**The first deployment should be to staging, and it should be boring.** If it is not boring, that is the finding.

---

*Next: [Chapter 23 — Coding Standards](23-coding-standards.md)*
