# Archived: web admin (2026-08-12)

Archived from:
- `apps/web/src/app/admin/` → `admin/`
- `apps/web/src/lib/admin/` → `lib-admin/`

**Why archived**: The admin portal has been migrated to `apps/admin/` (port 3001) as a
fully separate Next.js application with its own session-cookie auth, proxy Route Handlers,
and SSE stream proxies. Admin code must no longer live inside the trader-facing `apps/web`.

See `apps/admin/` for the canonical operator console.
