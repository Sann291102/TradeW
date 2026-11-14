# TradeW Monorepo Consolidation — Phase 1 Audit Findings

Date: 2026-08-04
Branch: `chore/monorepo-consolidation` (checkpoint commit `d5b500f`)
Scope: read-only audit only. Nothing has been archived, moved, or refactored yet.

## 0. Starting state

- Working tree had a large amount of uncommitted work (Admin Portal, Knowledge
  migration, SentinelIntelligence engine, telemetry/entitlements) — committed
  as-is as a checkpoint before this audit began, so it's preserved and diffable.
- `feature-updates` (previous branch) has diverged from `origin/feature-updates`
  by 7 commits each way — not touched, not pushed, not merged.
- Full findings from each sub-audit are in this directory: `apps-and-knowledge-audit.md`,
  `services-packages-audit.md`, `infra-ci-audit.md`, `docs-knowledge-audit.md`.

## 1. Knowledge feature: web → Admin Portal migration

**Frontend: fully migrated, clean.** `apps/web/src/app/knowledge/` is gone.
Nav config, command palette, and search providers were edited (not just
relabeled) to remove the entry, with dated comments. The only surviving path
is `apps/web/src/app/admin/knowledge/page.tsx`, gated by `AdminGate`/`AdminFrame`
(session token + operator token, checked against a live backend call).

**Backend: NOT migrated — live security gap.** The frontend's admin Knowledge
page calls `/knowledge/*`, a pre-existing NestJS module
(`services/api/src/knowledge/knowledge.controller.ts`) that is guarded only by
`KnowledgeWorkspaceGuard` — an environment on/off switch with **no JWT check,
no admin check, no operator-token check**. `services/api/.env` currently has
`KNOWLEDGE_WORKSPACE_ENABLED=true`, so the entire engineering knowledge vault
is reachable by an **unauthenticated** request to `/knowledge/graph`,
`/knowledge/tree`, `/knowledge/search`, etc. This contradicts `AdminFrame.tsx`'s
and `apps/web/src/app/admin/README.md`'s own claim that "every `/admin/*`
endpoint enforces both factors independently" — Knowledge isn't served under
`/admin/*` at all.

**Fix required:** move/mount the Knowledge controller under the same
double-gated `/admin/*` surface (or add the same guard used by
`AdminController`), so the API-level permission matches the UI-level one.

## 2. Duplicate / stub / orphaned code

| Item | Status |
|---|---|
| `apps/admin` (top-level) | Empty scaffold, unrelated README (DLQ worker/KYC). Real Admin Portal lives in `apps/web/src/app/admin/*`. Archive candidate. |
| `apps/mobile` | Empty placeholder, explicitly "do not build yet." |
| `apps/terminal` | Superseded static single-file HTML prototype, own README says so. Archive candidate. |
| `services/analytics`, `services/auth`, `services/notification`, `services/tradew-ai`, `services/trading-engine` | README-only stubs, no `package.json`, no code. `services/auth` logic actually lives in `services/api/src/auth/`; `services/tradew-ai` logic lives in `packages/ai-core`; `services/trading-engine` README describes a Python bot that doesn't exist anywhere in the repo (zero `.py` files found). |
| `packages/shared`, `packages/sdk` | Zero consumers repo-wide (only self-mentioned in a planning doc). Orphaned. |
| `services/api/.env.bak` | Backup file, gitignored, archive/remove candidate. |
| `docs.zip` (523KB, root) | Stale snapshot of `docs/` from 2026-07-27, missing later additions, zero unique content. Archive candidate. |
| `TRADEW_DEVELOPER_REFERENCE.md` (99KB) | Near-duplicate of `REPOSITORY_INVENTORY.md` (154KB, newer, actively cross-referenced). Archive candidate. |
| `PROJECT_TEST_AUDIT.md`, `SENTINEL_BRAIN_PROGRESS.md` | Superseded by `docs/APPLICATION-STATUS.md`. Archive candidates. |
| `implementation_plan.md` | Stray artifact from an external IDE session (paths point outside this machine/repo). Not a TradeW doc. Archive candidate. |
| `docs/README.md` | Badly stale — describes `docs/` as empty, omits `handbook/`, `product-architecture/`, `ai/`, `Trading Books/` entirely. Needs a rewrite, not archival. |
| `NotificationsClient.tsx` | Imports nonexistent `Spinner` from `@tradew/ui` (should be `Skeleton`) — breaks `apps/web` typecheck and the `/notifications` route today. This is a known, CI-documented bug, not something the audit is speculating about. |
| `services/market-data` | Real, fully-built NestJS service with **no Dockerfile, no compose entry, no CI test script** — invisible to deployment and CI despite being live code. |
| Root `README.md` claim vs `docs/APPLICATION-STATUS.md` | Direct contradiction: README (2026-07-29) claims "112 automated tests, ~80% complete"; APPLICATION-STATUS.md (2026-07-25) says "zero automated tests anywhere." Needs reconciliation against actual `npm test` output (part of the validation phase). |

**Not duplicates (verified, keep as-is):**
- `services/market-data` (NestJS runtime) vs `packages/market-data` (dependency-free provider library) — clean layering, not overlap.
- `knowledge/` (dated engineering vault, Sentinel's reasoning corpus source) vs `knowledge-base/` (static market-concept ontology) — genuinely distinct purposes, no content overlap.
- The Dhan Bridge exists in exactly **one** place: `packages/market-data/src/providers/dhan/dhan.feed.ts` + `dhan-binary-parser.ts`. `services/market-data/src/ingestion/dhan-websocket-factory.ts` and `apps/web/src/lib/dhanLiveFeed.ts` are thin consumers, not parallel implementations. (Note: live Dhan feed is "built, not enabled" — default is simulated.)

## 3. Environment variables

55 unique keys across the real runtime files (`.env`, `services/api/.env`,
`services/market-data/.env`, `services/sentinel/.env`, `apps/web/.env` +
`.env.local`). Root `.env` is already a **partial** consolidation — it
duplicates `DATABASE_URL`, `DHAN_ACCESS_TOKEN`, `JWT_SECRET`, `ADMIN_API_TOKEN`
etc. from the service `.env` files, and the values are consistent (not
conflicting) everywhere they overlap. What's still missing from root:

- Sentinel's AI-provider keys (`ANTHROPIC_API_KEY`, `NVIDIA_NIM_*`,
  `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`,
  `FIRECRAWL_API_KEY`, `OLLAMA_BASE_URL`, `AI_*_ORDER`)
- Market-data ingestion config (`MARKET_DATA_*`, `INGESTION_ENABLED`, `HOST`)
- `SENTINEL_SERVICE_TOKEN`/`SERVICE_TOKEN` — same shared secret, named
  differently on each side of the api↔sentinel call; needs one canonical name
- `KNOWLEDGE_WORKSPACE_ENABLED`, `KNOWLEDGE_ROOT`, `FRONTEND_URL`,
  `SENTINEL_SERVICE_URL`, `TWELVEDATA_API_KEY`
- Mail/OTP config (`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`) — present only in
  `services/api/.env.example`, **not set** in the actual `.env`, even though a
  commit (`feat(auth): password reset via email OTP`) shipped a feature that
  needs them. Likely means OTP email delivery is unconfigured/non-functional
  right now — worth confirming in the validation phase.
- No root `.env.example` currently exists at all.

`PORT` is defined per-service (api/market-data/sentinel) with different
values — that's correct (each service needs its own port), so consolidation
should namespace these (`API_PORT`, `MARKET_DATA_PORT`, `SENTINEL_PORT`)
rather than collapse them into one key.

## 4. Infra / CI

- Only `infra/docker/` is real (`docker-compose.yml` dev, `docker-compose.prod.yml`
  prod: caddy, web, api, sentinel, migrate, postgres, redis). `infra/k8s` and
  `infra/terraform` are empty READMEs; `infra/terraform` targets AWS while
  everything else targets Oracle Cloud — moot since it's empty, but inconsistent.
- `.github/workflows/ci.yml` and `deploy.yml` reference only real paths, no
  dangling references. `ci.yml`'s `typecheck-web` job already documents the
  `Spinner`/`Skeleton` bug above as a known failure.
- Top-level `workflows/` (n8n exports) is a distinct, real concept from
  `.github/workflows/` — confusingly named but not a collision, currently empty.
- `agents/sentinel/definitions.json` (5 agents) is real; `agents/tradew-ai/` is
  empty; the parent `agents/README.md` contradicts its own child README.
- The two Tailscale cert/key files at repo root are correctly gitignored,
  never tracked, no git history exposure — but a private key still sits
  unencrypted in the working tree.

## 5. Proposed next steps (pending your go-ahead)

1. **Fix the Knowledge backend auth gap** — mount `/knowledge/*` under the
   admin-guarded surface (or apply the same double-gate) so API access matches
   UI access. This is a security fix, not just cleanup.
2. **Fix the `Spinner`/`Skeleton` import** in `NotificationsClient.tsx` so
   `apps/web` typecheck passes.
3. **Archive** (move into `/archive`, categorized, documented, nothing deleted):
   `apps/admin` (top-level stub), `apps/terminal` (superseded prototype),
   `services/api/.env.bak`, `docs.zip`, `TRADEW_DEVELOPER_REFERENCE.md`,
   `PROJECT_TEST_AUDIT.md`, `SENTINEL_BRAIN_PROGRESS.md`, `implementation_plan.md`.
   Leave `services/analytics|auth|notification|tradew-ai|trading-engine` and
   `packages/shared|sdk` in place (they're intentionally-documented future
   placeholders per their own READMEs, not accidental duplicates) unless you'd
   rather those archived too — flagging for your call.
4. **Rewrite `docs/README.md`** to reflect what's actually in `docs/`.
5. **Consolidate environment variables** into root `.env` / `.env.example` per
   §3, update each service to read from root, remove now-redundant per-service
   `.env` files (keep `.env.example` per service or centralize — your call).
6. **Reconcile** the README "112 tests / 80% complete" claim against actual
   `npm test` results in the validation phase.
7. **Add** `services/market-data` to Docker/CI so it's not invisible to
   deployment.
8. **Run full validation**: install, build, lint, typecheck, test across all
   real (non-stub) workspaces; start services locally where feasible in this
   sandbox (no live broker credentials/production DB — will flag anything
   that can't be genuinely validated here vs. needs your environment).
9. Push branch, open PR, hand you the full before/after report. **I will not
   merge to main myself** — that's your call once you've reviewed.

Two things need your decision before I proceed:
- Should the intentionally-empty stub services/packages (§5, item 3 note) be
  archived too, or left as documented placeholders?
- GitHub (`github.com`/`api.github.com`) is still returning
  `403 blocked-by-allowlist` from my sandbox — I can't push/open the PR until
  that clears on your end.
