# packages/types 🟡

Shared TypeScript types/DTOs — the source of truth for request/response shapes between `services/api` and every `apps/*` client, and the basis `packages/sdk` is generated from.

**Consumed by:** `services/api`, `packages/ui`, `packages/sdk`, all `apps/*`.

**Status:** doesn't exist yet in any audited codebase — currently each frontend/backend copy defines its own shapes ad hoc. Extract this package once `services/api`'s NestJS DTOs stabilize; don't invent speculative types ahead of real endpoints.
