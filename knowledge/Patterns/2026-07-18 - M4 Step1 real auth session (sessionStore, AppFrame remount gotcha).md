---
type: pattern
date: 2026-07-18
tags: [pattern, frontend, phase-2, milestone-4, auth, zustand]
status: active
---

# Pattern: Milestone 4 Step 1 — real auth session wiring

## For future Claude
Phase 2, Milestone 4, Step 1 replaced the last placeholder identity UI (hardcoded "Paper Trader"/"PT") with a real session backed by `services/api`'s already-working auth endpoints. Read before touching `apps/web/src/lib/store/sessionStore.ts` or any page that needs to know "who is logged in."

## No new backend code
Every endpoint this step uses already existed and was already verified working (`POST /auth/login`, `/auth/signup`, `/auth/logout`, `GET /auth/me`, `GET /entitlements/me`) — see [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]. This step is pure frontend wiring, zero backend changes, zero new Prisma models, zero new migrations.

## sessionStore is deliberately NOT persisted
Unlike `workspaceStore` (localStorage-persisted UI state), `sessionStore` re-verifies against the server on every load via the token `lib/api.ts` already owns in localStorage. Session data is server-truth; caching a stale `user`/`capabilities` object in localStorage would drift from reality (e.g. an admin revokes entitlement server-side, stale client cache wouldn't know). `sessionStore` never touches `localStorage` directly — it only calls `getToken()`/`clearToken()` from `lib/api.ts`, avoiding a second, competing auth-storage implementation (the "do NOT duplicate auth logic" rule).

## The bug this step found and fixed: AppFrame doesn't remount on client-side navigation
`AppFrame` calls `useSessionStore.getState().init()` once in a `useEffect` on mount. That's correct for a fresh page load / hard reload. It is **not** enough for the login/signup flow: `AppFrame` is the persistent root-layout wrapper, so it does NOT remount when `login/page.tsx` calls `router.push('/dashboard')` after a successful login — the mount effect already ran (with no token) before the user typed anything. Verified live: after login, Sidebar/TopBar kept showing "Guest" until a hard reload, despite `localStorage` correctly holding the new token.

**Fix**: `login/page.tsx` and `signup/page.tsx` both call `await useSessionStore.getState().init()` explicitly, right after `setSession(...)` and right before `router.push(...)`. Any future "this succeeded but the shell didn't update" bug on a client-side-navigation-only flow should suspect the same root cause: a mount-only effect on a component that doesn't remount for that transition.

`logout()` doesn't have this problem — it calls `set(...)` directly inside the store action itself, not through a re-triggered mount effect, so it updates synchronously wherever `useSessionStore` is subscribed. Only *acquiring* a new session needed the explicit re-init; *clearing* one didn't.

## Entitlement display, honestly scoped
`GET /entitlements/me` returns `{ capabilities: string[] }` — a flat list, no per-plan/term detail (no "which of the 4 Sentinel tiers" endpoint exists). Settings' entitled-state UI reflects exactly that shape: one "ACTIVE" state across the whole Sentinel section, not a per-tier guess. Don't invent a more granular UI than the real endpoint can support — that would silently show fabricated data.

## Verified end-to-end (not just UI — a real DB round-trip)
Used the real `POST /entitlements/admin/subscriptions` admin endpoint (with `ADMIN_API_TOKEN` from `services/api/.env`) to grant a test user real `sentinel_pro`, confirmed Settings flipped to the "ACTIVE" card, then canceled the grant via `POST /entitlements/admin/subscriptions/:id/cancel` to leave the DB clean. This is the pattern for verifying entitlement-gated UI going forward: grant via the real admin endpoint, observe, revert — never fake the capability list client-side to "test" it.

## Files touched
New: `lib/store/sessionStore.ts`. Edited: `components/shell/AppFrame.tsx` (mount `init()`), `Sidebar.tsx`/`TopBar.tsx` (real identity, replacing hardcoded "PT"/"Paper Trader"), `app/profile/page.tsx` (consume the store instead of its own duplicate `/auth/me` fetch; added real Log out), `app/settings/page.tsx` → split into `SettingsClient.tsx` (real entitlement check) + a server-component `page.tsx` shell (same pattern as `/notifications` from Milestone 3 — a Client Component can't export `metadata`), `app/login/page.tsx` + `app/signup/page.tsx` (the re-init fix above), `lib/format.ts` (+`initials()` helper), `lib/api.ts`/`lib/knowledge.ts` (exported `API_URL` once instead of two files each declaring it — a small dedup the Step 0 audit flagged).

## Related
- [[../_INDEX.md]]
- [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]
- [[2026-07-18 - M3 dockable workspace (zustand store, dock engine, command palette)]] — the sibling non-persisted-vs-persisted store split this step follows
