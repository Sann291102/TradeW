# Infra / Ops / CI Audit

Scope: `infra/`, `.github/workflows/`, top-level `workflows/`, top-level `scripts/`,
top-level `agents/`, all Dockerfiles, root-level stray files. Read-only recon,
no repo changes made.

---

## 1. `infra/`

### `infra/README.md`
States three subfolders: `docker/` (local dev), `k8s/` (staging/prod on AWS
ap-south-1), `terraform/` (VPC/RDS/ElastiCache/EKS/S3). Explicitly says
**"Status: empty. Build `docker/` first... `k8s/` and `terraform/` come
later."** This is an honest, self-declared placeholder note, and it checks out
against the actual filesystem (see below).

### `infra/k8s/` — placeholder only
Contains **only `README.md`** (5 lines). No manifests, no Helm charts, nothing
deployable. README says "Status: empty. Don't build this before `infra/docker/`
proves the services work together locally." Confirmed empty via directory
listing.

### `infra/terraform/` — placeholder only
Contains **only `README.md`** (5 lines). No `.tf` files. Targets AWS
(VPC/RDS/Aurora/ElastiCache/EKS/S3) which is notably a **different cloud
target than what's actually being built** (see `infra/oci/`, which targets
Oracle Cloud). README self-labels "Status: empty... v0.9/v1.0-stage concern."
Confirmed empty.

### `infra/oci/` — real design doc, not deployable config itself
Contains **only `README.md`**, but it's a substantial (170-line) deployment
architecture document for Oracle Cloud Free Tier (Ampere A1 arm64 VM), fully
consistent with and cross-referencing the *actual* deployable artifacts in
`infra/docker/` and `.github/workflows/deploy.yml`. Unlike k8s/terraform, this
one honestly flags itself: **"Not validated in a live OCI environment... no
OCI VM was available to test an end-to-end deploy or an arm64 image build.
First deploy is the validation."** So: real, detailed, internally consistent
plan; zero live validation; no infra-as-code files of its own (by design — it
delegates to `docker/` for the runnable bits).

### `infra/docker/` — the only real, deployable config
Files: `docker-compose.yml`, `docker-compose.prod.yml`, `Caddyfile`,
`backup.sh`, `.env.prod.example`, `README.md`.

**`docker-compose.yml`** (local dev) defines only:
- `postgres` (pgvector/pgvector:pg16) — port `5433:5432`
- `pgadmin` (dpage/pgadmin4) — port `5050:80`

`infra/docker/README.md` says target end-state is `api + web + trading-engine
+ postgres + redis`, and that current status is "`postgres` only... `api`,
`web`, `trading-engine`, `redis` are not yet added." This is **stale/slightly
inaccurate**: the file also defines `pgadmin`, which the README doesn't
mention at all. Minor doc drift, not a functional problem.

**`docker-compose.prod.yml`** (production, single OCI VM) defines:
| Service | Image/build | Exposed | Notes |
|---|---|---|---|
| `caddy` | caddy:2 | **80, 443 (public)** | only public-facing service |
| `web` | build `apps/web/Dockerfile` | 3000 (internal `expose`) | Next.js |
| `api` | build `services/api/Dockerfile` | 4000 (internal) | NestJS, depends on `migrate` + `sentinel` |
| `sentinel` | build `services/sentinel/Dockerfile` | 4010 (internal) | depends on healthy postgres |
| `migrate` | reuses api image | — | one-shot `prisma migrate deploy`, exits |
| `postgres` | pgvector/pgvector:pg16 | internal only | tuned for 24GB VM |
| `redis` | redis:7-alpine | internal only | **provisioned but explicitly not consumed by any app code yet** (comment in file confirms) |

**Cross-check against `services/*` and `apps/*` (workspace-level reality):**
- `apps/`: `admin`, `mobile`, `terminal`, `web`
- `services/`: `analytics`, `api`, `auth`, `market-data`, `notification`,
  `sentinel`, `tradew-ai`, `trading-engine`

Only `web`, `api`, `sentinel` have container definitions. Checked each of the
others for whether they're real code that's missing a container, or just
placeholder scaffolding:
- `apps/admin`, `apps/mobile` — **README-only, "design-only"/"empty on
  purpose."** No package.json, no source. Not a gap — nothing to containerize yet.
- `apps/terminal` — a single static `index.html` (220KB), explicitly marked
  **"superseded static prototype," historical reference only**, run via
  `python -m http.server`, not part of the real build. Not a gap.
- `services/analytics`, `services/auth`, `services/notification` — **README-only,
  "design-only, no code exists yet"/"placeholder."** Not a gap.
- `services/trading-engine` — README-only, **"not yet populated. Waiting on
  execution approval."** Not a gap (intentionally gated).
- `services/tradew-ai` — README-only; README explicitly redirects: **"the real
  TradeW AI agent/RAG/memory/provider logic (~1,697 lines) already exists in
  `packages/ai-core`, not here."** So no service-level container needed (the
  logic is a library, consumed by `services/api`), consistent with there being
  no `services/tradew-ai` container.
- **`services/market-data` — a real, built service with no container
  definition.** This one IS a gap worth flagging: it has a real
  `package.json` (`@tradew/market-data-service`), a NestJS `nest-cli.json`,
  a `dist/` build output, a `scripts/` dir, and a live `.env` — i.e. actual
  working code — but **no `Dockerfile`, no entry in either compose file, and
  no `test` script** (so it's silently skipped by `npm test --workspaces
  --if-present` in CI, not failed — just invisible). It's described in its own
  package.json as "Singleton by design... Never reached by apps/*," i.e. an
  internal feed-ingestion runtime that `api`/`sentinel` presumably depend on
  at runtime but which isn't wired into either compose stack or CI test
  coverage.

No dangling reverse references found: every service that *does* have a
container definition (`web`, `api`, `sentinel`, plus infra-only `postgres`,
`redis`, `caddy`, `migrate`) corresponds to a real directory in the repo. No
compose service points at a nonexistent path.

**`Caddyfile`**: single public entrypoint, same-origin `/api/*` reverse-proxy
to `api:4000` (strips prefix), everything else to `web:3000`. Sentinel is
deliberately not routed publicly. SSE flush disabled for the Knowledge
Workspace stream. Consistent with the compose file and OCI README.

**`backup.sh`**: nightly `pg_dump | gzip` → OCI Object Storage via `rclone`,
retention pruning, restore instructions in the header comment. References
`docker-compose.prod.yml` correctly. Cron setup documented but not itself
installed anywhere in-repo (expected — it's a VM-side cron entry).

**`.env.prod.example`**: template with `CHANGE_ME_*` placeholders for DB
password, JWT secret, shared service token (must match between `api`'s
`SENTINEL_SERVICE_TOKEN` and `sentinel`'s `SERVICE_TOKEN` per its own
comment), optional AI provider keys, and `IMAGE_*` registry refs meant to be
set by CI. No real secrets present — this is a template, correctly named
`.example` and excluded from git (see `.gitignore`).

---

## 2. `.github/workflows/`

### `ci.yml`
Triggers: every push (branches-ignore: none) + every PR + manual dispatch.
Three jobs, all `ubuntu-latest`, all `actions/checkout@v4` +
`actions/setup-node@v4` (node 20, npm cache) + `npm ci`:

1. **`test`** — runs `npx prisma generate --schema packages/database/prisma/schema.prisma`
   then `npm test` (root script = `npm run test --workspaces --if-present`).
   Comment in the file says this covers `apps/web`, `services/api`,
   `services/sentinel`, `packages/market-data`. **Verified accurate** — those
   are exactly the four workspaces with a `test` script:
   - `apps/web`: `"test": "vitest run"`
   - `services/api`: `"test": "vitest run"`
   - `services/sentinel`: `"test": "vitest run"`
   - `packages/market-data`: `"test": "npm run verify"` (→ `ts-node scripts/verify-parser.ts`)
   - `services/market-data` (the *service*, distinct from the *package*) has
     **no `test` script** — silently excluded, not a CI failure, just no
     coverage (see gap noted above).
2. **`typecheck`** — `npx tsc --noEmit -p services/api/tsconfig.json` and
   `-p services/sentinel/tsconfig.json`. Both tsconfig paths exist and were
   verified on disk.
3. **`typecheck-web`** — separate job, `npx tsc --noEmit -p apps/web/tsconfig.json`.
   Path exists. The file's own comment documents a **known, currently-broken
   state**: as of 2026-08-03, `apps/web` does not typecheck cleanly because
   `NotificationsClient.tsx` imports a `Spinner` component from `@tradew/ui`
   that doesn't exist (the design system uses `Skeleton` instead), causing
   TS2305 and a blank `/notifications` page at runtime. This is split into its
   own job specifically so it fails visibly without masking the other two
   suites. **This is a real, currently-broken CI check**, not a config bug —
   worth flagging to the team as an open item, not an infra audit false
   positive.

All referenced paths (`packages/database/prisma/schema.prisma`,
`services/api/tsconfig.json`, `services/sentinel/tsconfig.json`,
`apps/web/tsconfig.json`) confirmed to exist. No dangling references.

The file's header comment is itself notable: it states that **before this
file was added, `deploy.yml` was the only workflow, ran only on `main`, and
went straight to `docker build` — meaning no test suite in the repo was
actually gating anything before `ci.yml` existed.**

### `deploy.yml`
Triggers: push to `main` with path filters (`apps/web/**`, `services/**`,
`packages/**`, `infra/docker/**`, `.github/workflows/deploy.yml`) + manual
dispatch. Two jobs:

1. **`build`** — matrix of exactly `web` (`apps/web/Dockerfile`), `api`
   (`services/api/Dockerfile`), `sentinel` (`services/sentinel/Dockerfile`).
   QEMU + buildx for `linux/arm64` cross-build (matches OCI Ampere A1 target),
   pushes to `ghcr.io/<owner>/tradew-{name}:latest` and `:{sha}`, GHA layer
   cache. All three Dockerfile paths verified to exist on disk and match
   exactly the three services that appear in `docker-compose.prod.yml`. No
   dangling matrix entries.
2. **`deploy`** — `needs: build`, SSHes to the VM (`SSH_HOST`/`SSH_USER`/`SSH_KEY`
   secrets) and runs `git pull --ff-only`, `compose pull`, `compose run --rm
   migrate`, `compose up -d`, `docker image prune -f` against
   `infra/docker/docker-compose.prod.yml`. Consistent with the compose file
   and the OCI README's documented deploy flow.

**Consistency check, ci.yml vs deploy.yml vs actual services:** the set of
services with (a) a Dockerfile, (b) a compose entry in prod, and (c) a build
matrix entry in `deploy.yml` is identical: `{web, api, sentinel}`. No
dangling references in either workflow file. The one real gap is upstream of
CI entirely: `services/market-data` has real code but isn't in that set at
all (no Dockerfile → can't be in the matrix even if someone wanted to add it).

---

## 3. Top-level `workflows/` (distinct from `.github/workflows/`)

**Real, distinct concept — not a naming collision**, though the shared name
is legitimately confusing at a glance. Per `workflows/README.md`: this is
**version-controlled JSON exports of n8n workflows** (internal ops
automation — alert fanout, KYC document processing, EOD reports, on-call
paging). The n8n engine itself is vendored/out-of-tree; this folder holds
just the workflow *definitions* so changes go through code review instead of
being edited live inside a running n8n instance. Explicitly scoped to
**"never customer-facing trade logic, never anything on the sub-150ms trading
hot path."**

**Current contents: only the README.** No JSON exports exist yet — the README
says so explicitly ("Status: no exports exist yet — nothing has been built in
n8n for TradeW specifically"). Confirmed via directory listing (single file).
Not referenced anywhere in `.github/workflows/` or `infra/` (grepped, only
self-references found).

---

## 4. Top-level `scripts/`

Per `scripts/README.md`: intended for repo-wide tooling that doesn't belong
in any single app/service/package — planned scripts are `bootstrap` (dev
setup), `codegen` (SDK generation from OpenAPI), `seed` (DB seed successor to
an old prototype's seed script), `migrate-check` (CI guard for schema/migration
drift). **README says "Status: empty" for these** — and directory listing
confirms none of the four planned scripts exist yet.

However, the directory is **not actually empty** — it also contains
`requirements.txt`, which isn't mentioned in the README at all (doc gap).
`requirements.txt` pins `dhanhq==2.3.0rc1` (a pre-release SDK) with a header
comment explaining: this is Python tooling used only for **exploring/
verifying the Dhan broker API** as a reference implementation, explicitly
**not** the dependency set for `services/trading-engine` and **not** used in
the actual request path (TradeW's own market-data parsing is TypeScript, in
`packages/market-data/src/providers/dhan/`).

Usage check: grepped the whole repo for references to `scripts/requirements.txt`
or `pip install` from it. Found only in prose docs (`REPOSITORY_INVENTORY.md`,
`ARCHITECTURE.md`, `services/trading-engine/README.md`) — **not invoked by
any CI workflow, compose file, or npm script.** It's standalone manual
tooling for a developer to run locally when doing broker API exploration, not
part of any automated pipeline.

---

## 5. Top-level `agents/`

Per `agents/README.md`: **declarative AI agent definitions** (system prompts,
allowed tools, guardrails) as version-controlled, code-reviewed files. Split
into two subfolders specifically because **TradeW AI and Sentinel are
separate systems** with separate runtimes:

- `agents/tradew-ai/` — 8 planned agents (AI Researcher, Company Analysis,
  News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder,
  Portfolio Insights, Learning Assistant). **Contains only README.md** — no
  definitions written yet. README: "Status: empty. Write `ai-researcher`
  first... once `services/tradew-ai` exists to run it."
- `agents/sentinel/` — 5 planned agents (market-technical, emotion,
  trap-safety, compliance-audit, orchestrator). **Contains README.md +
  `definitions.json`** — an actual populated config (63 lines) defining all
  5 agents with system prompt IDs, guardrails, and tiers. This is real
  content, not a placeholder.

**Relationship to `services/sentinel` and `services/tradew-ai`: not a
duplicate, and the distinction is explained (if you dig one level past the
top-level README).** `agents/` holds *declarative config only* — system
prompt IDs, guardrail text, allowed-tools lists. The actual executable agent
logic lives in the services: `services/sentinel/src/{intelligence,compliance,
orchestrator}/` for Sentinel, and (per `services/tradew-ai/README.md`)
`packages/ai-core` for TradeW AI (not `services/tradew-ai` itself, which is
still README-only and redirects there). So the intended architecture is
config/definitions (`agents/`) vs. runtime/implementation (`services/*`,
`packages/ai-core`).

**One real inconsistency worth flagging:** the top-level `agents/README.md`
says **"Status: no definitions exist yet"** for the whole directory, but
`agents/sentinel/README.md` (dated "corrected 2026-07-21") contradicts this —
it says the folder "has a `definitions.json` config file." The top-level
README is stale relative to its own child README. Minor doc-drift, easy fix,
but confusing if someone trusts the parent README's status line at face
value without checking the child.

---

## 6. Dockerfiles — full inventory

Searched `apps/`, `services/`, `infra/` for any file named `Dockerfile*`.
**Exactly three exist in the entire repo:**

| Path | Used by |
|---|---|
| `apps/web/Dockerfile` | `docker-compose.prod.yml` (`web`), `deploy.yml` matrix |
| `services/api/Dockerfile` | `docker-compose.prod.yml` (`api` + `migrate`, which reuses the api image), `deploy.yml` matrix |
| `services/sentinel/Dockerfile` | `docker-compose.prod.yml` (`sentinel`), `deploy.yml` matrix |

**No Dockerfile exists for:** `apps/admin`, `apps/mobile`, `apps/terminal`,
`services/analytics`, `services/auth`, `services/market-data`,
`services/notification`, `services/trading-engine`, `services/tradew-ai`.
For all of these except `services/market-data`, that's expected/by-design —
they're placeholder/design-only directories with no source code to build. For
`services/market-data`, this is the one real gap (real code, no way to
containerize it yet — see §1).

---

## 7. Root-level stray files

- **`.dockerignore`** — present, sensible content (`node_modules`, `dist`,
  `.next`, `.env*` except `.env.example`, `.git`, `coverage`, plus explicitly
  excludes `knowledge`, `docs`, `archive`, `infra/k8s`, `infra/terraform` from
  the build context — reasonable, keeps image build context lean).

- **`tradew-demo.tail2a580c.ts.net.crt`** and
  **`tradew-demo.tail2a580c.ts.net.key`** — Tailscale funnel TLS cert +
  private key, sitting at the repo root.

  **Security check performed:**
  - `.gitignore` (lines 32-34) explicitly excludes them: `tradew-demo.*.ts.net.crt`
    / `tradew-demo.*.ts.net.key`, with a comment "never commit the private key."
  - `git check-ignore -v` confirms both files currently match those
    `.gitignore` rules.
  - `git ls-files -- "tradew-demo*"` returns **nothing** — they are not
    currently tracked.
  - `git log --all --oneline -- <each path>` returns **empty** — no commit
    history exists for either path in this repository (not committed and then
    later gitignored/removed; they were never committed at all).
  - `git status --short` shows a clean tree (they don't even show as
    untracked, because they're ignored).

  **Conclusion: this is local-only material, correctly gitignored, never
  committed — not a live git-history secret-exposure incident.** That said, it
  is still a real live private key sitting unencrypted in the repo working
  tree on disk (4849-byte cert, 227-byte key, both dated 2026-07-29), which is
  worth the team being deliberate about (e.g. confirming no backup/sync tooling
  scoops up the whole working tree including ignored files, and that the
  gitignore rule doesn't accidentally get removed or narrowed later). Flagging
  as a hygiene/process risk, not a confirmed breach.

---

## Summary of dangling/broken references found

Cross-checking CI + compose against actual repo structure turned up **no
broken paths** — every path, workspace name, tsconfig, Dockerfile, and script
referenced in `ci.yml`, `deploy.yml`, and both compose files exists and is
correctly named. The issues found are all **gaps or drift, not breakage**:

1. `services/market-data` — real, built NestJS service with no Dockerfile, no
   compose entry (dev or prod), and no `test` script — invisible to both
   deployment and CI.
2. `infra/docker/README.md` is stale (doesn't mention the `pgadmin` service
   that's actually in `docker-compose.yml`).
3. `scripts/README.md` doesn't mention `scripts/requirements.txt`, the one
   real file that already exists in an otherwise "empty" directory.
4. `agents/README.md` (parent) says "no definitions exist yet"; contradicted
   by `agents/sentinel/README.md` (child), which correctly notes
   `definitions.json` exists.
5. `ci.yml`'s `typecheck-web` job documents a real, currently-unresolved
   TypeScript error in `apps/web` (missing `Spinner` export from `@tradew/ui`)
   — this is a genuine open CI failure, not an audit artifact.
6. `infra/terraform/` targets AWS while the actually-planned/documented
   deployment (`infra/oci/README.md`, `deploy.yml`) targets Oracle Cloud —
   the Terraform placeholder is aimed at a cloud provider that isn't the one
   currently being built toward. Not urgent since the directory is empty, but
   worth noting so nobody starts writing AWS Terraform for an OCI deployment.
