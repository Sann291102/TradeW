# Archived — apps/admin token-only session (superseded 2026-08-12)

These three files were the standalone console's original authentication, from
before it had an operator identity:

- `session.ts` — a signed session MARKER, `expiresAtMs.hmac(ADMIN_API_TOKEN)`.
  It proved a browser had once presented the operator token and carried **no
  person**.
- `session.test.ts` — its unit tests.
- `api-session-route.ts` — was `app/api/session/route.ts`; `POST` logged in with
  the raw `ADMIN_API_TOKEN`, `DELETE` logged out.

They were replaced by Phase 2 of the admin consolidation, which gives the
console a real per-person identity:

- `apps/admin/src/lib/operatorSession.ts` — AES-256-GCM sealed session carrying
  a real operator assertion.
- `apps/admin/src/lib/operatorAuth.ts` — server-side operator login.
- `apps/admin/src/app/api/auth/login|logout/route.ts` — the new auth endpoints.

Kept per workspace Rule 1 (superseded code is archived, never deleted). See
`knowledge/Decisions/2026-08-12 - Operator identity for the standalone admin
console.md`.
