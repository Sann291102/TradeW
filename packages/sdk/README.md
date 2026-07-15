# packages/sdk 🟡

A typed client generated from `services/api`'s OpenAPI spec. Used internally by every `apps/*` today; becomes the basis of the PRD's Phase 3 "public developer API" (roadmap month 12–18) once that ships externally.

**Depends on:** `packages/types`.

**Status:** doesn't exist yet — build this once `services/api` has enough stable endpoints to generate a spec from. Don't hand-write a client ahead of that; generate it.
