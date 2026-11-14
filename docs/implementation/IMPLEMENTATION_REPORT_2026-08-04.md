# TradeW Monorepo Consolidation — Implementation Report

**Date:** 2026-08-04
**Branch:** `chore/monorepo-consolidation` (based on `feature-updates` at `c5cc887`)
**Commits:** `d5b500f`, `c47d214`, `28f858f`, `145c9d0`
**Status:** Ready for review. Not merged — pending your sign-off and, separately, this sandbox's GitHub network access (see §9).

---

## 1. Starting state

The working tree had a large amount of uncommitted work already in progress when this task began: an Admin Portal (`apps/web/src/app/admin/*`), a Knowledge-feature migration from the public web app into it, the SentinelIntelligence reasoning engine, and telemetry/entitlements additions. None of it was lost — it was committed as-is (`d5b500f`) as a baseline before any audit or cleanup work, so every subsequent change is a clean diff on top of it.

The branch `feature-updates` had also diverged from `origin/feature-updates` by 7 commits each way. This work happened on a new branch, `chore/monorepo-consolidation`, cut from `feature-updates` — `feature-updates` itself was not touched, rebased, or pushed to.

## 2. Repository structure — before and after

**Before:**

```
apps/        admin (stub) · mobile (stub) · terminal (legacy prototype) · web (real)
services/    analytics · api · auth · market-data · notification · sentinel · tradew-ai · trading-engine
             (5 of 8 were README-only stubs; market-data had no Docker/CI presence)
packages/    ai-core · database · market-data · sdk · shared · types · ui
             (sdk, shared: zero consumers anywhere in the repo)
root docs/   ARCHITECTURE.md, PROJECT_TEST_AUDIT.md, README.md, REPOSITORY_INVENTORY.md,
             SENTINEL_BRAIN_PROGRESS.md, SENTINEL_MASTER_PLAN.md,
             TRADEW_DEVELOPER_REFERENCE.md, implementation_plan.md, docs.zip
env files/   14 separate .env / .env.example files across root, apps/web, 3 services,
             packages/database, infra/docker — no root .env.example at all
```

**After:**

```
apps/        mobile (stub, untouched — documented placeholder) · terminal (empty, contents archived) ·
             web (real; admin portal lives inside it) — apps/admin archived
services/    analytics · api · auth · market-data (now has Dockerfile + CI + compose entry) ·
             notification · sentinel · tradew-ai · trading-engine
             (the 5 stubs are unchanged — confirmed intentional placeholders, not archived)
packages/    ai-core · database · market-data · sdk · shared · types · ui  (unchanged; sdk/shared
             still orphaned and still intentionally left in place — see §4)
root docs/   ARCHITECTURE.md (updated), README.md, REPOSITORY_INVENTORY.md, SENTINEL_MASTER_PLAN.md,
             IMPLEMENTATION_REPORT_2026-08-04.md (this file)
             — PROJECT_TEST_AUDIT.md, SENTINEL_BRAIN_PROGRESS.md, TRADEW_DEVELOPER_REFERENCE.md,
             implementation_plan.md, docs.zip moved to archive/root-docs/
env files/   ONE root .env / .env.example (55+ keys, documented). Two narrow, unavoidable
             exceptions (apps/web/.env.local, packages/database/.env) — both mirrors, not forks.
             All other .env/.env.example files left in place as deprecation-notice placeholders
             (this sandbox's filesystem can't delete files outright — see §9).
```

Nothing was deleted. `apps/admin` and `apps/terminal` are now empty directories (their contents moved into `archive/`) rather than removed, for the same filesystem reason.

## 3. Duplicates detected and how they were resolved

| Item | Finding | Resolution |
|---|---|---|
| `apps/admin` vs `apps/web/src/app/admin` | Top-level `apps/admin` was an unbuilt stub whose README described an unrelated feature (DLQ retry worker/KYC review). The real Admin Portal was built inside `apps/web`. | Archived `apps/admin` (`archive/apps-admin-stub-superseded/`). |
| `apps/terminal` vs `apps/web/src/components/terminal` | Static single-file HTML prototype, superseded by the real terminal UI in `apps/web`, per its own README. | Archived (`archive/apps-terminal-legacy-prototype/`). |
| `TRADEW_DEVELOPER_REFERENCE.md` vs `REPOSITORY_INVENTORY.md` | Near-duplicate repository catalogs (99KB vs 154KB); the inventory is newer and cross-referenced elsewhere. | Older doc archived; inventory kept as current. |
| `docs.zip` vs `docs/` | 523KB zip snapshot of `docs/` from 2026-07-27, diffed against live `docs/` — no unique content. | Archived. |
| `services/api/.env.bak` | Backup of a file containing live secrets (Dhan tokens, JWT secret), already gitignored specifically to keep it out of git history. | **Deliberately not archived** — moving it into a tracked directory would commit those secrets permanently for the first time. Left untracked; recommend deleting by hand. |
| `services/sentinel/.env` / `packages/database/.env` `DATABASE_URL` | Pointed at Postgres port 5432; every other config (root `.env`, `services/api/.env`, `services/market-data/.env`, `docker-compose.yml`'s `5433:5432` mapping) used 5433. A real, silent bug — Sentinel was one restart away from talking to the wrong database. | Canonicalized on 5433 in the consolidated root `.env`. |
| `packages/database/.env` | File was corrupted: contained a literal PowerShell heredoc (`@"..."@ \| Out-File ...`) instead of an env var, apparently pasted in by accident rather than executed. | Replaced with a correct, minimal, documented single-line file. |
| Root `.env`'s `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_DHAN_LIVE_URL` | An earlier partial consolidation had copied the *production* relative-path values (`/api`, `/feed`) into the *dev* root `.env`, which didn't match what `apps/web` actually used locally (`http://localhost:4000`/`:4600`). | Corrected to the working dev values; prod values remain correctly separate in `infra/docker/.env.prod.example`. |
| `apps/web/.env` vs `apps/web/.env.local` | Byte-identical content; Next.js reads both, `.env.local` wins. | `.env.local` kept as the canonical Next.js-convention file; `.env` reduced to a deprecation note (see §9 on why it isn't fully removed). |
| `SENTINEL_SERVICE_TOKEN` (read by `services/api`) vs `SERVICE_TOKEN` (read by `services/sentinel`) | Same shared secret, two different env var names on each side of the same call. | **Not renamed in code this pass** (see §10 — flagged as a follow-up to limit blast radius on auth-critical code without live integration testing available). Both names are set to the same value in the consolidated `.env`, documented as such. |
| `docs/README.md` | Described `docs/` as empty and referenced folders (`build-plan/`) and a `CONSOLIDATION-PLAN.md` that no longer exist. | Rewritten to describe the actual current contents (`handbook/`, `product-architecture/`, `product/`, `design-reference/`, `ai/`, `Trading Books/`). |
| `docs.zip`, per-service `.env.example`, `ARCHITECTURE.md` §1.5/§7 | Not literal file duplicates, but doc drift — see §7 and §10. | Updated where practical; remaining drift flagged as tech debt. |

Five services (`analytics`, `auth`, `notification`, `tradew-ai`, `trading-engine`) and two packages (`shared`, `sdk`) are zero-code, README-only placeholders. Each README explicitly documents itself as intentional future work — at your direction (see the mid-session check-in), these were **left in place**, not archived, since they aren't accidental duplicates or abandoned attempts.

## 4. The Knowledge feature — why it still appeared in the web UI

This was the specific case named in the task, and it turned out to be two separate bugs layered on top of each other:

**Frontend (already fixed before this session, verified during audit):** `apps/web/src/app/knowledge/` was fully removed; nav config, the command palette, and search providers were all edited — not just relabeled — to drop the public entry. The only surviving route is `apps/web/src/app/admin/knowledge/page.tsx`, wrapped in `AdminGate`/`AdminFrame`.

**Backend (found during this audit, fixed this session):** the frontend's admin Knowledge page called `/knowledge/*`, a pre-existing NestJS controller guarded *only* by `KnowledgeWorkspaceGuard` — a feature on/off switch, not authentication. With `KNOWLEDGE_WORKSPACE_ENABLED=true` (the non-production default, and the actual value in this repo's `.env`), the entire engineering knowledge vault — architecture decisions, gotchas, agent research notes — was reachable by an **unauthenticated** HTTP request. This directly contradicted the frontend's own code comment, which believed the route already required a bearer token; it never did.

**Fix applied:** `KnowledgeController` moved from `/knowledge` to `/admin/knowledge`, and now requires both `KnowledgeWorkspaceGuard` (still governs whether the route exists at all) *and* `AdminGuard` (the same isAdmin-JWT + operator-token double factor every other `/admin/*` route requires). The frontend (`apps/web/src/lib/admin/knowledge.ts`) was switched from the plain product API client to the admin client, so requests now actually carry both credentials; its SSE subscription was updated to the same query-param credential pattern already used for `/admin/stream` (`EventSource` can't set headers). `AdminGuard`'s SSE allowlist was generalized from one hardcoded path to an explicit set covering both streams.

**Verified:** no remaining reference to the old `/knowledge` path in `apps/web/src` (nav, links, search index, sitemap); no remaining import of the old `apps/web/src/lib/knowledge.ts`; `services/api` has no other Knowledge controller; `apps/web`, `services/api`, and `services/sentinel` all typecheck clean with these changes in place.

## 5. Incomplete / partially implemented features found

- **Password-reset-via-email-OTP** (shipped in a prior commit) has no SMTP credentials configured anywhere (`SMTP_HOST/USER/PASS` are blank in every `.env` that ever had them). In this state the mailer logs the OTP to the console instead of sending real email — functional for local testing, not for a real user.
- **`services/trading-engine`** — README describes a "real, hardened" Python bot (`extreme_algo_bot_v2.py`, etc.) in present tense, but zero `.py` files exist anywhere in the repo. The README's own last line contradicts its header: "Status: not yet populated."
- **Live Dhan market data** — built (`packages/market-data/src/providers/dhan/`) but not enabled by default; `MARKET_DATA_PROVIDER` defaults to `simulated` in `services/market-data`. The root `.env` in this repo currently sets it to `dhan`, so this specific checkout is running live — worth confirming that's intended before wider distribution of this config.
- **Root `README.md` vs `docs/APPLICATION-STATUS.md`** — a direct factual contradiction: the README (dated 2026-07-29) claims "112 automated tests, ~80% complete," while `APPLICATION-STATUS.md` (2026-07-25) states "zero automated tests anywhere in the repository" as its top risk. Test files clearly exist now (`packages/market-data` has a real, passing suite; `.spec.ts` files exist under `services/api` and `services/sentinel`), so neither claim is fully accurate as written — this needs a maintainer pass with real `npm test` output (see §8 for what could and couldn't be run in this sandbox) rather than a guess from me.
- **`packages/shared` / `packages/sdk`** — zero consumers repository-wide; effectively vaporware placeholders, left in place per your direction.
- **`infra/k8s/`, `infra/terraform/`** — README-only, no actual manifests; `infra/terraform/README.md` targets AWS while every other prod doc (`infra/oci/`, `deploy.yml`) targets Oracle Cloud. Moot while both are empty, but worth reconciling before either is built out.

## 6. Broken references fixed

- Knowledge API route/guard mismatch (§4).
- `packages/database/.env`'s corrupted PowerShell-heredoc content (§3).
- `services/sentinel/.env` / `packages/database/.env` pointing at the wrong Postgres port (§3).
- Root `.env`'s mismatched `NEXT_PUBLIC_*` values (§3).
- `docs/README.md` describing nonexistent folders and a nonexistent `CONSOLIDATION-PLAN.md` (§3).
- `ARCHITECTURE.md` §1.5 and §7 contradicting the now-actual "one root `.env`" state (updated to record the reversal and why — see §7).
- `.github/workflows/ci.yml`'s comment describing the `Spinner`/`Skeleton` typecheck bug as current — it was already fixed in the working tree prior to this session; comment updated to past tense.
- `infra/docker/.env.prod.example`'s comment describing the Knowledge route at the old `/api/knowledge` path.
- `services/market-data/README.md` and `scripts/README.md`'s env setup instructions, updated to point at the root file.

**Not chased down:** historical mentions of the old `/knowledge` API path inside `REPOSITORY_INVENTORY.md` and archived docs, and the per-service-`.env.example` principle still stated in `docs/handbook/02, 03, 05, 14, 19`. These are point-in-time documents; updating every historical mention would blur the line between "record of what happened" and "current state." Flagged in §10 instead.

## 7. Environment consolidation summary

One root `.env` (real values, gitignored, never committed) and one root `.env.example` (placeholders + full documentation, tracked in git) now cover all 55+ keys previously scattered across `apps/web/.env(.local)`, `services/api/.env`, `services/market-data/.env`, `services/sentinel/.env`, and `packages/database/.env`.

`services/api/src/main.ts`, `services/market-data/src/main.ts`, `services/sentinel/src/main.ts`, and every `scripts/*.ts` CLI in those two service directories now resolve the root `.env` by explicit path (`resolve(__dirname, '../../../.env')`) instead of relying on `dotenv/config`'s cwd-relative default — so they read the same file no matter how they're started (npm workspace script, `ts-node` directly, or the compiled `dist/`). This does not affect production: Docker containers inject env vars directly via `env_file`/`environment` in `docker-compose.prod.yml`, dotenv's `config()` call simply no-ops when the root `.env` path doesn't exist inside the container, and dotenv never overwrites already-set `process.env` values by default.

Ports were namespaced (`API_PORT`, `MARKET_DATA_PORT`, `SENTINEL_PORT`) with a fallback to the old generic `PORT` for compatibility.

Two exceptions remain, both unavoidable and both documented in place: `apps/web/.env.local` (Next.js can only read env files from the app's own directory, and inlines `NEXT_PUBLIC_*` into the client bundle at build time) and `packages/database/.env` (the Prisma CLI resolves `.env` from its own working directory). Both now just mirror the relevant root values rather than diverging from them.

This reverses a documented architectural principle (`ARCHITECTURE.md` §1.5, "every service ships its own `.env.example`," originally adopted to fix a "three disconnected credential surfaces" issue). `ARCHITECTURE.md` has been updated to record the reversal and the reasoning — the per-service pattern had, in practice, drifted into exactly the kind of inconsistency it was meant to prevent (the Postgres-port bug above). `docs/handbook/02-company-principles.md`, `03-product-requirements.md`, `05-system-architecture.md`, `14-monorepo.md`, and `19-security.md` still state the old principle and should be updated in a follow-up pass — not done here to keep this change's footprint legible.

## 8. Build / lint / typecheck / test results

Run directly in this sandbox against the consolidated branch:

| Check | Result |
|---|---|
| `packages/types` build | ✅ Clean |
| `packages/ai-core` build | ✅ Clean |
| `packages/market-data` build | ✅ Clean |
| `packages/market-data` tests | ✅ 43/43 assertions pass (binary tick-packet parser round-trip suite) |
| `services/api` typecheck (`tsc --noEmit`) | ✅ Clean |
| `services/api` build (`nest build`) | ✅ Clean |
| `services/sentinel` typecheck | ✅ Clean |
| `services/sentinel` build | ✅ Clean |
| `services/market-data` typecheck | ✅ Clean |
| `services/market-data` build | ✅ Clean |
| `apps/web` typecheck | ✅ Clean (confirms the previously-known `Spinner`/`Skeleton` bug stays fixed) |
| `apps/web` lint (`next lint`) | ✅ Clean |
| `apps/web` production build (`next build`) | ⚠️ **Not completed** — see below |
| `services/api` / `services/sentinel` / `apps/web` test suites (`vitest run`) | ⚠️ **Could not run** — see below |
| `prisma generate` | ⚠️ **Could not run** — see below |

Three things could not be validated **in this sandbox specifically**, all environment limitations rather than code defects:

1. **Vitest test suites** (api, sentinel, web) fail at startup with `Cannot find module '@rollup/rollup-linux-x64-gnu'`. `node_modules` was installed on your Windows machine and only carries the Windows-native Rollup binary; this sandbox is Linux and has no network access to `registry.npmjs.org` (blocked by the sandbox's egress allowlist) to fetch the Linux one. This is a known, general npm optional-dependencies issue (npm/cli#4828), not something introduced by this work. **Recommend running `npm test` yourself locally, or trusting CI** — `.github/workflows/ci.yml`'s `test` job runs on a fresh Linux GitHub Actions runner via `npm ci`, which installs the correct native binary from a registry it can reach.
2. **`next build`** did not complete within this sandbox's 45-second per-command execution limit; the working tree is mounted over a network filesystem (FUSE) which is slow for Next.js's file-heavy compile step, and background processes don't persist between tool invocations here to let it run longer. `next build` internally runs the same type-check and lint that already passed cleanly above, so confidence is reasonably high, but the build itself is unconfirmed. Recommend running `npm run build -w @tradew/web` yourself, or trusting `deploy.yml`'s Docker build on push to `main`.
3. **`prisma generate`** failed to fetch its query-engine checksum from `binaries.prisma.sh` (same network allowlist restriction). The already-generated Prisma client in `node_modules/.prisma` also only has a Windows engine binary (`query_engine-windows.dll.node`), no Linux one — so any code path that actually instantiates `PrismaClient` at runtime (as opposed to just importing its generated types, which typecheck already exercised) is unverified here. Schema itself is unchanged in this pass, so risk is low, but it's unconfirmed.

I also fixed several broken `@tradew/*` workspace symlinks in `node_modules` (readable on Windows, unreadable via this sandbox's Linux FUSE bridge — `Input/O error` on every read) by recreating them as plain relative symlinks; that's a local-sandbox-only fix (`node_modules` is gitignored) and doesn't affect your actual checkout.

No live services, database, Docker containers, queues, or scheduled jobs were started or tested — this sandbox has no Docker daemon (`docker` command not found) and no running Postgres. Docker build/compose correctness could only be verified by reading the Dockerfiles and compose files against the actual build/run commands, not by executing them.

## 9. Running services / ports — not executed, documented instead

Given §8's constraints, no service was actually booted end-to-end in this sandbox. For reference, the intended local topology (unchanged by this work, `services/market-data` now added to the picture):

| Service | Port | Health check |
|---|---|---|
| `apps/web` (Next.js) | 3000 | — |
| `services/api` | 4000 (`API_PORT`) | `GET /health` |
| `services/sentinel` | 4010 (`SENTINEL_PORT`) | `GET /health` |
| `services/market-data` | 4020 (`MARKET_DATA_PORT`) | `GET /health` (now wired into `docker-compose.prod.yml`'s healthcheck, previously absent) |
| Standalone Dhan live-feed bridge (`services/market-data/scripts/live-feed-server.ts`) | 4600 | not containerized (§10) |
| Postgres (dev, docker-compose.yml) | 5433→5432 | `pg_isready` |
| pgAdmin (dev) | 5050 | — |

## 10. Remaining blockers, technical debt, recommendations

**Blocker on merge:** GitHub (`github.com` / `api.github.com`) is returning `403 blocked-by-allowlist` from this sandbox even after you enabled it mid-session — I was unable to push `chore/monorepo-consolidation` or open the PR automatically. **You'll need to push this branch and open the PR yourself**, or re-check the allowlist and let me retry:

```
git push origin chore/monorepo-consolidation
# then open a PR against main on GitHub
```

I have not merged anything into `main`, per your instruction — that's your call once you've reviewed.

**Technical debt / recommendations, roughly in priority order:**

1. `SENTINEL_SERVICE_TOKEN`/`SERVICE_TOKEN` — same secret, two names. Worth a follow-up rename to one canonical name once you can run a live api↔sentinel integration test to confirm nothing breaks; not done in this pass to limit risk on auth-critical code without that ability in this sandbox.
2. Confirm the README "112 tests, ~80% complete" claim against a real `npm test` run (blocked here, see §8) and reconcile it with `docs/APPLICATION-STATUS.md`'s contradictory claim.
3. `services/market-data` and its tests: it now has a Dockerfile, compose entry, and CI typecheck, but genuinely has zero tests written (no `test` script at all, not a CI gap). Worth prioritizing given it's the sole writer of live `Quote` data.
4. The standalone Dhan live-feed bridge (`services/market-data/scripts/live-feed-server.ts`, port 4600) is a separate, real, un-containerized process that `DHAN_LIVE_URL` points every consumer at (web, api, sentinel). It has no Dockerfile, no compose entry, no process supervision — a bigger gap than the NestJS ingestor this pass addressed, and out of scope here since it wasn't the specific finding flagged for fixing.
5. `docs/handbook/02, 03, 05, 14, 19` still state the reversed "per-service `.env.example`" principle (§7) — update in a follow-up doc pass.
6. `infra/terraform/README.md` targets AWS while every other prod doc targets Oracle Cloud — reconcile before either is built out.
7. `services/api/.env.bak` — recommend deleting by hand (contains live secrets, already gitignored, intentionally not touched by this automation — see §3).
8. Rotate `ADMIN_API_TOKEN`, `ANTHROPIC_API_KEY`, `NVIDIA_NIM_API_KEY`, and the Dhan credentials that now sit in the consolidated root `.env` if this repository or its history is ever shared more widely than it already implicitly has been — consolidating them into one file doesn't change their sensitivity, just their location.
9. This sandbox's filesystem could rename files but not delete them outright, so several superseded `.env`/`.env.example` files were left in place as deprecation-notice placeholders rather than actually removed (§3, §7) — safe to delete by hand on your machine; noted individually in each file.
