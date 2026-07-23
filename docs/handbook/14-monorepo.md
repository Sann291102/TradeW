# Chapter 14 — Monorepo

**Status: 🟢 for structure and tooling; 🔵 for several packages that exist as folders only.**

---

## 14.1 Why a monorepo

| Reason | Concretely |
|---|---|
| **One type contract** | `packages/types` is the single source of truth for API DTOs. A response shape change breaks the client at compile time, not in production. |
| **Atomic cross-cutting changes** | Adding a field to `Order` touches the schema, the service, the DTO, and the UI in one commit and one review. |
| **One dependency graph** | The rules in Chapter 5 §5.8 are checkable because everything is in one tree. |
| **Shared tooling** | One TypeScript version, one Prisma version, one Node version. |
| **Onboarding** | `git clone` gets you the whole system, not six repos and a wiki page explaining which order to start them in. |

### 14.1.1 The costs, stated

- The repository is large and clones slowly
- A CI run that rebuilds everything on every change is wasteful — hence path-triggered builds (§14.8)
- It is easy to create an accidental dependency between things that should be independent — hence the dependency-graph rules being written down and enforced in review

---

## 14.2 Tooling: npm workspaces

```json
{
  "name": "tradew",
  "private": true,
  "workspaces": ["apps/*", "services/*", "packages/*"],
  "engines": { "node": ">=20" }
}
```

**npm workspaces. Not pnpm, not Yarn, not Turborepo, not Nx.** There is no `pnpm-workspace.yaml` and no `turbo.json`, and their absence is deliberate rather than an oversight.

| Considered | Why not (yet) |
|---|---|
| pnpm | Better disk efficiency and a stricter dependency graph. Real benefits — but npm workspaces ships with Node, and "the tool everyone already has" beats a marginal improvement at this size. |
| Turborepo / Nx | Task graphs, remote caching, affected-project detection. Genuinely valuable **above a build-time threshold we have not reached.** Adopting them now buys caching for builds that take under a minute. |

This is Principle 7 applied to tooling: adopt the more powerful tool when a measured problem demands it, not in anticipation. The trigger is a full build exceeding ~5 minutes, or CI cost becoming material.

### 14.2.1 Root scripts

```json
"scripts": {
  "build":     "npm run build --workspaces --if-present",
  "build:api": "npm run build -w @tradew/api",
  "build:web": "npm run build -w @tradew/web",
  "dev:api":   "npm run start:dev -w @tradew/api",
  "dev:web":   "npm run dev -w @tradew/web",
  "dev:sentinel":     "npm run start:dev -w @tradew/sentinel",
  "db:generate":      "npm run generate -w @tradew/database",
  "db:migrate":       "npm run migrate  -w @tradew/database",
  "ontology:validate":"npm run ontology:validate -w @tradew/sentinel",
  "ontology:seed":    "npm run ontology:seed     -w @tradew/sentinel"
}
```

`--if-present` means a workspace without a `build` script is skipped rather than failing the whole run. `packages/ui` has no build step at all (§14.5.3), and that must not break `npm run build`.

---

## 14.3 Folder structure

```
TradeW/
├── apps/
│   ├── web/          🟢 Next.js 14 — the trader-facing application
│   ├── admin/        🔵 internal ops console (README only)
│   ├── mobile/       🔵 React Native (README only, Y3)
│   └── terminal/     ⚪ static HTML — the CANONICAL design reference
│
├── services/
│   ├── api/          🟢 NestJS — the single public ingress
│   ├── sentinel/     🟢 NestJS — Safety Nets runtime
│   ├── market-data/  🟡 NestJS — ingestion runtime (singleton)
│   ├── auth/         🔵 extraction contract boundary
│   ├── trading-engine/ 🔵 Python/Flask — un-migrated
│   ├── tradew-ai/    🔵 Research runtime
│   ├── notification/ 🔵 alert fan-out
│   └── analytics/    🔵 portfolio analytics
│
├── packages/
│   ├── database/     🟢 the single Prisma schema + migrations
│   ├── types/        🟢 shared DTOs and domain contracts
│   ├── ui/           🟢 design system (source-only, no build)
│   ├── ai-core/      🟢 AI foundation (~2,300 lines)
│   ├── market-data/  🟢 feed contracts, Dhan adapter, OU simulator
│   ├── shared/       🔵 config loader, logger, error types
│   └── sdk/          🔵 generated OpenAPI client
│
├── agents/
│   ├── sentinel/     🟡 definitions.json (config, not source)
│   └── tradew-ai/    🔵 README only
│
├── knowledge/        🟢 Obsidian engineering vault (NOT in the runtime)
├── knowledge-base/   🟢 66 market concepts, YAML (IS in the runtime)
├── docs/             🟢 product architecture + this handbook
├── infra/            🟡 docker 🟢 · k8s/terraform/oci 🔵
├── workflows/        🔵 n8n JSON exports
├── scripts/          🔵 repo-wide tooling
└── archive/          🟢 superseded code — retained, never deleted
```

### 14.3.1 The `apps/terminal` oddity

`apps/terminal` is static HTML and is **not an application**. It is the canonical design reference — `packages/ui`'s tokens were extracted from it verbatim (§14.5.2). It is in `apps/` for historical reasons and is not built or deployed.

> ⚠️ Do not delete it. `tokens.css` says values must match it byte-for-byte, so deleting it makes the design system unverifiable.

---

## 14.4 Naming convention

Every workspace is scoped `@tradew/*`:

| Package | Name | Note |
|---|---|---|
| `apps/web` | `@tradew/web` | |
| `services/api` | `@tradew/api` | |
| `services/sentinel` | `@tradew/sentinel` | |
| `services/market-data` | `@tradew/market-data-service` | ⚠️ `-service` suffix |
| `packages/market-data` | `@tradew/market-data` | the library |
| `packages/database` | `@tradew/database` | |
| `packages/types` | `@tradew/types` | |
| `packages/ui` | `@tradew/ui` | |
| `packages/ai-core` | `@tradew/ai-core` | |

> ⚠️ **`@tradew/market-data` is the library; `@tradew/market-data-service` is the runtime.** The folder names are identical (`market-data` under `packages/` and under `services/`) and the package names differ by a suffix. This *will* trip you up. Rule: **`packages/*` is what you import; `services/*` is what you run.**

---

## 14.5 The packages

### 14.5.1 `packages/database` 🟢

> *"Single Prisma schema + migration history — the one schema owner for Postgres."*

```
packages/database/
├── prisma/
│   ├── schema.prisma     719 lines, 21 models, 6 enums
│   ├── migrations/       5 migrations, zero drift
│   └── seed.ts           ⚠️ broken (see below)
└── package.json
```

Consumers point their own Prisma config at this schema rather than copying it:

```json
// services/api/package.json
"prisma": { "schema": "../../packages/database/prisma/schema.prisma" },
"scripts": {
  "prisma:generate": "prisma generate --schema ../../packages/database/prisma/schema.prisma"
}
```

> ⚠️ **`seed.ts` is broken.** `seedDemoAccount()` throws `bcrypt.hash is not a function` — a pre-existing `ts-node` ESM/CJS interop bug, confirmed unrelated to any recent change, not yet fixed. Tracked as TD-1.

### 14.5.2 `packages/types` 🟢

Shared TypeScript domain contracts: entitlements/subscriptions, the `MarketDataProvider` abstraction, `Candle`, `NewsItem`, API DTOs.

**Why a separate package and not just Prisma's generated types:** Prisma types describe *rows*. API contracts describe *responses*, which are frequently different — `PositionDto` has `unrealizedPnl`, `mtm`, and `priceStatus`, none of which are columns. Coupling the wire format to the schema means every schema change is a breaking API change.

### 14.5.3 `packages/ui` 🟢 — the source-only pattern

```json
{
  "type": "module",
  "main":  "./src/index.ts",     // ← source, not dist
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./styles.css": "./src/styles/tokens.css",
    "./tailwind-preset": "./src/tailwind-preset.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit" }   // ← no build
}
```

```js
// apps/web/next.config.js
const nextConfig = {
  // Consume the shared design-system package directly from TS source — no
  // separate build step for @tradew/ui.
  transpilePackages: ['@tradew/ui'],
};
```

**No build step at all.** Next.js compiles the package's TypeScript as part of the app build.

| Gain | Cost |
|---|---|
| Edit a component → HMR immediately | Only consumable by bundlers that can transpile it |
| No stale `dist/` ever | Not publishable to npm as-is |
| No build ordering in CI | |
| Tree-shaking works on real source | |

For an internal design system consumed only by Next.js apps, this is strictly better than a build step. The moment `apps/mobile` (React Native, Metro) needs it, this decision gets revisited.

### 14.5.4 `packages/ai-core` 🟢

```
packages/ai-core/src/
├── domain/knowledge.ts   shared knowledge types
├── providers/            LLM/Embedding/Research contracts + ProviderManager
├── memory/               Memory Engine + VectorStore
├── graph/                Knowledge Graph contracts
├── rag/                  retrieval + chunking
├── research/             Research Engine
├── brain/                Neural Brain pipeline + Learning Engine
├── context/              token-budgeted prompt assembly
├── prompts/              Prompt Library + CORE_GUARDRAILS
├── tools/                Tool Registry (NO order-placement tools, by design)
├── agents/               Agent SDK
└── news/                 13-category event classifier
```

> **This is where TradeW AI actually lives** — not in `services/tradew-ai` or `agents/tradew-ai`, which are README-only. Chapter 18.

Note it has **zero runtime dependencies** — only `typescript` and `@types/node` as devDependencies. Provider implementations use `fetch`. A shared foundation package that pulls in an SDK forces that SDK on every consumer.

### 14.5.5 `packages/market-data` 🟢

Feed contracts, the Dhan adapter and binary parser, the OU simulator, the token bucket, the quote cache. Framework-free on purpose (Chapter 12 §12.8.2).

### 14.5.6 `packages/shared` 🔵 — a real gap

`ARCHITECTURE.md` §6 specifies it as the config loader (fail-fast env validation), structured logger, and common error types, consumed by **every Node service**. It is currently a folder with a README.

The consequence is visible: each service reads `process.env` directly, and the fail-fast-at-boot rule (ARCH-6) is therefore not actually enforced anywhere. Tracked as TD-2.

### 14.5.7 `packages/sdk` 🔵

Typed client generated from `services/api`'s OpenAPI spec. Blocked on the API not yet emitting an OpenAPI document.

---

## 14.6 Dependency rules

```
   ALLOWED
     apps/*      →  services/api (network) · packages/{ui,types,sdk}
     services/*  →  packages/{database,types,shared,ai-core,market-data}
     packages/*  →  other packages/* (acyclic)

   FORBIDDEN
     packages/*  →  apps/*          circular
     packages/*  →  services/*      circular
     apps/*      →  services/* (import)   ARCH-1 — network only
     apps/*      →  packages/database     apps never touch Prisma
     services/tradew-ai ↔ services/sentinel   independent systems
```

### 14.6.1 `packages/database` is consumed by `services/api` only

`services/sentinel` uses its **own** `PrismaService` against its **own** tables. Sharing a Postgres *instance* is fine; sharing ORM *ownership* of a table is not (ARCH-5).

### 14.6.2 Why `apps/*` never import `packages/database`

Two reasons, both fatal:

1. Prisma is a server-side client. Importing it into a Next.js client component leaks a database driver — and potentially a connection string — into the browser bundle.
2. It bypasses the ingress. Auth, entitlements, and audit all live in `services/api`.

---

## 14.7 Build

### 14.7.1 What each workspace does

| Workspace | Build command | Output |
|---|---|---|
| `apps/web` | `next build` | `.next/` |
| `services/api` | `nest build` | `dist/` |
| `services/sentinel` | `nest build` | `dist/` |
| `services/market-data` | `nest build` | `dist/` |
| `packages/ai-core` | `tsc -p tsconfig.json` | `dist/` |
| `packages/types` | `tsc -p tsconfig.json` | `dist/` |
| `packages/market-data` | `tsc -p tsconfig.json` | `dist/` |
| `packages/database` | *(generate only)* | Prisma client |
| `packages/ui` | **none** | — |

### 14.7.2 Build order

npm workspaces does **not** compute a task graph. Order is currently the declaration order in `workspaces`, which happens to work: `apps/*`, `services/*`, `packages/*` — and since `apps/web` transpiles `packages/ui` from source and services import compiled packages that build quickly, it has not bitten yet.

> ⚠️ **This is fragile.** A future package with a real inter-package build dependency will break it. That is one of the concrete triggers for adopting Turborepo (§14.2).

### 14.7.3 Prisma generation ordering

> ⚠️ **Gotcha (cost: an afternoon).** `nest build` fails with cryptic type errors if `prisma generate` has not run — the `@prisma/client` types do not exist until generation. Run `npm run db:generate` after any schema change, after a fresh clone, and after switching a branch that touched the schema.

---

## 14.8 CI

**Code:** `.github/workflows/deploy.yml`

### 14.8.1 Path-triggered

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'apps/web/**'
      - 'services/**'
      - 'packages/**'
      - 'infra/docker/**'
      - '.github/workflows/deploy.yml'
```

A docs-only change does not rebuild three container images.

### 14.8.2 Matrix build to arm64

```yaml
env:
  REGISTRY: ghcr.io
  PLATFORMS: linux/arm64      # ← OCI Ampere A1 is arm64

strategy:
  matrix:
    include:
      - { name: web,      dockerfile: apps/web/Dockerfile }
      - { name: api,      dockerfile: services/api/Dockerfile }
      - { name: sentinel, dockerfile: services/sentinel/Dockerfile }
```

Built with `setup-qemu-action` for arm64 emulation on amd64 runners, cached via `type=gha`.

**Note `services/market-data` is not in the matrix.** It is not yet deployed — an honest reflection of Chapter 12's status, and a gap to close before the live feed goes on.

### 14.8.3 Deploy

```bash
cd /opt/tradew
git pull --ff-only
COMPOSE="docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod"
$COMPOSE pull
$COMPOSE run --rm migrate     # ← migrations as a one-shot service
$COMPOSE up -d
docker image prune -f
```

**Migrations run as a separate one-shot container before the app starts.** Correct: it fails loudly and independently, and no application container starts against an un-migrated database.

### 14.8.4 What CI does not do 🔴

```
   ✅ build images        ✅ push to registry        ✅ deploy
   ❌ run tests           (none exist)
   ❌ lint                (no ESLint config exists)
   ❌ typecheck           (only implicit, inside each build)
   ❌ check coverage
   ❌ enforce performance budgets
   ❌ security scan
   ❌ compliance-language check
```

This is a **deploy pipeline, not a CI pipeline.** Chapter 22 §22.3 specifies the full one.

---

## 14.9 Configuration

### 14.9.1 Per-service environment (ARCH-6)

No shared "god" `.env`. Each service ships its own `.env.example`. This directly fixed the "three disconnected credential surfaces" finding from the consolidation audit.

| Service | Key variables |
|---|---|
| `services/api` | `DATABASE_URL`, `JWT_SECRET`, `SENTINEL_URL`, `SERVICE_TOKEN`, `DHAN_LIVE_URL`, `PORT` |
| `services/sentinel` | `DATABASE_URL`, `SERVICE_TOKEN`, `ANTHROPIC_API_KEY?`, `VOYAGE_API_KEY?`, `NVIDIA_NIM_BASE_URL?` |
| `services/market-data` | `DATABASE_URL`, `DHAN_CLIENT_ID?`, `DHAN_ACCESS_TOKEN?`, `FEED_PROVIDER` |
| `apps/web` | `NEXT_PUBLIC_API_URL` |

**Every AI key is optional.** The platform boots and functions without any of them (Principle 10).

### 14.9.2 Fail-fast validation 🔵

Specified: `packages/shared`'s config loader validates required variables at **process boot**, not at first use. A missing `DATABASE_URL` should crash at startup, not throw at 09:16 IST on the first order.

**Not implemented** — `packages/shared` does not exist. TD-2.

### 14.9.3 TypeScript configuration

Each workspace owns its `tsconfig.json`. There is no root `tsconfig.base.json` with shared compiler options, which means settings can drift between workspaces. Minor debt; worth fixing when adding the linter.

---

## 14.10 Local development

### 14.10.1 The fifteen-minute path

```bash
git clone <repo> && cd TradeW
npm install

docker compose -f infra/docker/docker-compose.yml up -d
npm run db:generate
npm run db:migrate
npm run ontology:validate && npm run ontology:seed

# three terminals
npm run dev:api        # :4000
npm run dev:sentinel   # :4100
npm run dev:web        # :3000
```

**No API keys. No cloud services. No broker account.**

### 14.10.2 The compose stack

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16     # ← pgvector built in
    ports: ['5433:5432']              # ← 5433, not 5432
    healthcheck: pg_isready -U tradew -d tradew

  pgadmin:
    image: dpage/pgadmin4:latest
    ports: ['5050:80']
```

Two details:

- **`pgvector/pgvector:pg16`**, not plain `postgres:16`. The extension is required by `MemoryRecord.embedding` and `ConceptNode.embedding`; a plain image fails at migration time.
- **Host port 5433**, so it does not collide with a locally-installed Postgres — a small courtesy that saves a confusing afternoon.

### 14.10.3 What runs without keys

| Component | Without keys |
|---|---|
| LLM | `ProviderNotAvailableError` → deterministic composition |
| Embeddings | absent → text-match search |
| Research | silent no-op (not even logged — it is the expected state) |
| Market data | OU simulator, deterministic per (symbol, trading day) |
| Broker | the paper OMS *is* the product |

---

## 14.11 Adding to the monorepo

### 14.11.1 A new package

```
□ Does an existing package cover most of it?  (TRADEW-OS §6.1)
□ Would it introduce a cycle?                 (§14.6)
□ Name it @tradew/<folder-name>
□ Decide: source-only (transpilePackages) or built (tsc → dist)?
□ Minimise dependencies — a shared package's deps become everyone's
□ Framework-free if more than one runtime will consume it
□ Add a README stating what it is and who consumes it
```

### 14.11.2 A new service

**Requires an architecture review** (Chapter 5 §5.14). Before writing code:

```
□ Which extraction trigger in §5.7 fired?
□ Which new arrow does it add to the dependency graph?
□ Is it reachable only through services/api?    (ARCH-1)
□ Does it need a ServiceTokenGuard?             (yes, unless it is the ingress)
□ Which tables does it own?                     (ARCH-5)
□ .env.example, Dockerfile, health endpoint, CI matrix row
□ What is its blast radius when down?
```

### 14.11.3 A new app

Almost certainly the wrong answer. `TRADEW-OS.md` §6.2: a new user-facing capability is **a workspace surface under the shared chrome**, not a new app. One row in `NAV_ITEMS` is the usual correct answer.

A new app is justified only for a genuinely different runtime (React Native) or a genuinely different audience with different auth (`apps/admin`).

---

## 14.12 Known debt

| ID | Debt | Impact | Fix |
|---|---|---|---|
| TD-1 | `seed.ts` throws `bcrypt.hash is not a function` | demo account seeding broken | resolve the ts-node ESM/CJS interop |
| TD-2 | `packages/shared` does not exist | ARCH-6 fail-fast config is unenforced | build the config loader + logger |
| TD-3 | No ESLint config anywhere | standards enforced by humans | add flat config + CI step |
| TD-4 | Indicator maths duplicated client/server | numbers can disagree | `packages/indicators` |
| TD-5 | No root `tsconfig.base.json` | compiler settings drift | extract shared options |
| TD-9 | Build order is declaration order, not a graph | fragile as packages grow | Turborepo when the trigger fires |
| TD-10 | `services/market-data` absent from the CI matrix | cannot be deployed | add a row + Dockerfile |

---

*Next: [Chapter 15 — Frontend Architecture](15-frontend-architecture.md)*
