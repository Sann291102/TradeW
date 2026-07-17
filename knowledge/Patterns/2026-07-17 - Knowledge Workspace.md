---
type: pattern
date: 2026-07-17
tags: [pattern, knowledge-management, frontend, api]
status: implemented
---

# Knowledge Workspace — in-app vault viewer

## For future Claude
Read this before adding another way to view the vault, or before wondering how the `/knowledge` page and `/knowledge/*` API work. This is an implemented, verified feature (Sprint 1). It's a read-only window over `TradeW/knowledge/` — filesystem is the single source of truth, no database.

## What it is
An internal developer page at `apps/web` route `/knowledge` that renders the Obsidian vault so agents' output is visible without opening Obsidian. Backed by a read-only NestJS module in `services/api` (`services/api/src/knowledge/`).

## API (all under `/knowledge`, on services/api :4000)
- `GET /tree` — folder/file tree (dirs + .md only)
- `GET /file?path=` — content + frontmatter + resolved outbound links + backlinks
- `GET /recent?limit=` — files by mtime, created/modified status
- `GET /search?q=&limit=` — full-text over filename/title/tags/content, ranked
- `GET /graph` — nodes + wiki-link edges
- `GET /activity?since=` — change-event ring buffer
- `GET /stream` — SSE live change feed (created/modified/deleted)

## Key design decisions
- **Snapshot-diff poller (2s), not `fs.watch`** — cross-platform, reliably catches deletes, zero dependency. Maintains a derived in-memory index (rebuilt each poll, mtime-incremental reads) that backs tree/search/graph/recent; the same poll emits the SSE change events. `file` reads fresh from disk so the viewer is never stale.
- **Auth**: gated solely by `KnowledgeWorkspaceGuard` (`KNOWLEDGE_WORKSPACE_ENABLED`; off in production unless explicitly enabled, returns 404 when off). Deliberately **no per-user JWT** — it's an internal dev viewer of engineering docs, and requiring login forced a database round-trip that defeated the "just show me the vault" purpose (and `EventSource` can't send a bearer header anyway). If enabled in production, it must sit behind ingress/network auth — do not rely on this controller for user auth. (Originally shipped with `AuthGuard` on content endpoints; relaxed 2026-07-17 after it blocked logged-out/DB-down use.)
- **Path-traversal hardened** (`safeResolve` rejects escapes; verified 403).
- **Frontend deps** (each maps to a requirement): `react-markdown` + `remark-gfm` (markdown/tables/checklists), `mermaid` (diagrams, lazy-loaded). Knowledge graph is a hand-built SVG force layout — no heavy graph dependency. Raw HTML is NOT rendered (no rehype-raw) — XSS-safe by default.
- **"Agent" in Agent Activity is inferred** from the note's top-level folder, not true per-agent instrumentation (see remaining work).

## Env
- `KNOWLEDGE_ROOT` — vault path override (default `../../knowledge` from the service cwd)
- `KNOWLEDGE_WORKSPACE_ENABLED` — `true`/`false`/unset (unset = on outside production)

## Remaining work
- True per-agent attribution needs the agents to emit events (e.g. a write-hook posting `{agent, action, path}`); today the category is folder-inferred.
- `modified` status heuristic uses birthtime≈mtime (< 1.5s) — filesystems without reliable birthtime may mislabel.
- Not yet covered by automated tests (consistent with the repo's current zero-test state — see [[../Plans/2026-07-17 - Platform audit and implementation roadmap]] Sprint 1).

## Related
- [[../_INDEX.md]]
- [[../Plans/2026-07-17 - Platform audit and implementation roadmap]]
