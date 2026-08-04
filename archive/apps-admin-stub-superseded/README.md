# apps/admin 🟡

New — an internal ops/support/compliance console. Nothing in the audited codebases maps here directly, but the need is already visible in the audit:

- The trading engine has an unfinished **Dead Letter Queue** (table exists, no retry worker or UI) — admin gives ops a place to inspect and retry stuck orders once the worker is built.
- The auth module already logs **audit events** (login/signup/refresh, IP/UA) — admin is where someone actually reads that log, rather than querying the database by hand.
- KYC/compliance review (SEBI algo-trading rules, DPDP Act per the architecture doc) needs a human-in-the-loop screen somewhere that isn't the trader-facing app.

**Talks to:** `services/api` only, using admin-scoped endpoints/permissions (same single-ingress rule as `apps/web`).

**Depends on:** `packages/ui`, `packages/types`, `packages/sdk`.

**Status:** design-only. Build after `apps/web` and `services/api` are stood up and the DLQ retry worker exists — an admin UI for a feature that doesn't work yet isn't useful.
