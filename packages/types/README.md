# packages/types 🟢

Shared TypeScript types/DTOs — the source of truth for request/response shapes between `services/api` and every `apps/*` client, and the basis `packages/sdk` will be generated from.

**Consumed by:** `services/api`, `packages/ui`, `apps/web`, `apps/admin` (and `packages/sdk` once it's built). Built to `dist/` via `npm run build -w @tradew/types`.

**Status:** 🟢 built and consumed across the monorepo. It is one of the three packages the root `postinstall` builds first (`@tradew/types`, `@tradew/ai-core`, `@tradew/market-data`) because everything else resolves them from their built `dist/`. Keep it the single home for cross-boundary shapes; don't reintroduce ad-hoc per-app copies.
