# Workspace Continuity — Product Blueprint

Status: design, pre-implementation. Introduced by the Genesis v2 direction update (§13). Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §1 ("the application is always alive").

## 1. The principle

TradeW is an operating system, not a website — so it must **resume, not restart.** When a user returns, the workspace continues exactly where they left off. A cold, empty page on every visit is the single strongest tell that a product is "just another broker website," which `TRADEW-OS.md` §1 explicitly rejects.

## 2. What gets restored

| State | Owned by | Notes |
|---|---|---|
| Open tabs / active workspace | `services/api` (workspace session) | which surfaces were open, which was focused |
| Watchlists + active watchlist tab | `services/api` (existing watchlist domain) | already persisted; continuity ties it into session restore |
| Charts (symbol, timeframe, indicators, drawings) | `services/api` (or TradingView layout store for the TV workspace, `TRADINGVIEW-WORKSPACE.md` §4) | the chart state the user last had open |
| AI conversations | `services/tradew-ai` (conversation history) | the docked-assistant thread, resumable mid-conversation |
| AI context | derived, not stored raw | the *active page context* is recomputed on load from the restored route (`TRADEW-ASSISTANT.md` §4); only the conversation itself persists |
| Learning progress | `services/api` (`learning_progress` table, `LEARNING-HUB.md` §4) | resume the lesson/path where left off |
| Research | Sentinel Brain (Research Vault, `RESEARCH-VAULT.md`) | the user's in-flight research threads |
| Pending tasks | `services/api` (new `workspace_tasks` or reuse notifications) | anything the user flagged to return to |

## 3. Where continuity state lives

A new **workspace-session** concept owned by `services/api`, persisting per-user the layout/tab/focus state above. It references (does not duplicate) the domain data — it stores "watchlist X was active," not a copy of watchlist X; "conversation Y was open," not a copy of the messages (those stay in `services/tradew-ai`). This keeps one schema owner per table (`TRADEW-OS.md` §2.5) and avoids the continuity layer becoming a stale second copy of everything.

```
workspace_session (services/api)
  ├─ open_surfaces[]     → route refs
  ├─ focused_surface
  ├─ active_watchlist_id → references watchlist domain
  ├─ open_chart_state    → symbol/timeframe/indicators (or TV layout ref)
  ├─ open_conversation_id → references services/tradew-ai
  ├─ learning_resume_ref  → references learning_progress
  └─ pending_task_ids[]   → references tasks
```

## 4. Restore flow

1. User authenticates → `services/api` loads their `workspace_session`.
2. `apps/web` rehydrates the shell: reopens surfaces, focuses the last-active one, restores watchlist/chart state.
3. Referenced data is fetched lazily per surface (the AI conversation loads when the dock opens, not eagerly on login) — continuity restores *what was open*, not a full eager fetch of everything, preserving the performance rules (`TRADEW-OS.md` §8, no blocking the initial render).
4. Live data reconnects and the restored surfaces come alive — the "always alive" feel.

## 5. Boundaries

- Continuity restores **UI/session state**, never re-executes actions — reopening the Orders view shows orders; it never re-submits an order (`TRADEW-OS.md` §2.3).
- Restore is best-effort and degrades gracefully: if a referenced entity is gone (deleted watchlist, expired conversation), that surface opens empty rather than blocking the whole restore.
- No sensitive data in the session blob beyond references and non-sensitive layout state (`ARCHITECTURE.md` privacy posture).

## 6. Open items

- Whether pending tasks reuse the notification domain or get a dedicated `workspace_tasks` table — decide when the feature is built.
- Cross-device continuity (resume on a different machine) vs. per-device — server-owned session makes cross-device the natural default, but confirm at build time.

## 7. Implementation status (Phase 1, Milestone 3)

**Client-local (localStorage) implementation shipped; server-owned `workspace_session` not yet built** — Milestone 3 explicitly excluded backend integration. `apps/web`'s zustand-persisted `workspaceStore` implements this document's continuity contract entirely client-side today: open workspace tabs, panel/layout state, selected symbol, sidebar state, and theme all survive a reload. See [`WORKSPACE-SHELL.md`](WORKSPACE-SHELL.md) §6 for the exact shape and the hydration-safety approach. The store's schema was deliberately kept close to §3's `workspace_session` sketch above so migrating to the server-owned version is a transport change (swap localStorage for `services/api` calls), not a redesign.
