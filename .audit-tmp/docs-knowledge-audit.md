# TradeW Docs & Knowledge Audit
Generated: 2026-08-04 (read-only reconnaissance, no files modified)

---

## 1. `docs/` tree

Full recursive listing confirmed. Subfolders:

| Folder | Files | Content |
|---|---|---|
| `docs/Trading Books/` | 14 PDFs | Third-party trading education books (Day Trader's Bible, Swing Trading, Trading Volatility, Price Action, Trading Psychology, etc.) — reference material, not authored docs. |
| `docs/ai/` | 1 file (`DISTILLATION.md`) | Explains how TradeW uses NVIDIA's "AI Model Distillation for Financial Data" blueprint for the news-event classifier (`packages/ai-core/src/news/news-event-classifier.ts`). Current, technical, well-scoped — no staleness markers. |
| `docs/design-reference/` | `DESIGN-SYSTEM.md` + `prototype/README.md` | Design tokens/system doc, plus a 4-line pointer note: the old prototype terminal (`index.html`) was git-renamed on 2026-07-16 to `apps/terminal/index.html` — this pointer file is intentionally a stub, not stale. |
| `docs/handbook/` | 28 files (`00-front-matter` … `27-future-vision`) | A full "engineering handbook" — front matter, exec summary, product requirements, platform overview, system architecture, Sentinel foundations/departments/engines/runtime, safety nets, paper trading, market data, chart engine, monorepo, frontend/backend architecture, database, AI architecture, security, performance, testing, devops, coding standards, engineering processes, decision records, future vision. This is the most comprehensive single doc set in the repo — each chapter 16–41KB. All dated 2026-07-23 (single authoring pass). |
| `docs/product/` | `TradeW-Project-Vision-and-Business-Overview.docx` + `.pdf` | Business/vision deck, binary formats, dated 2026-07-21. |
| `docs/product-architecture/` | 24 files + `README.md` | Per-feature architecture specs: TRADEW-AI, LEARNING-HUB, TRADINGVIEW-WORKSPACE, RESEARCH-VAULT, EXPLAINABILITY, AGENT-ARCHITECTURE, CONTINUOUS-LEARNING-PIPELINE, N8N-WORKFLOWS, MARKET-DATA-ARCHITECTURE, MARKET-WORKSPACE, KNOWLEDGE-GRAPH, DHAN-MARKET-DATA-INTEGRATION, MARKET-DATA-BASELINE, TRADEW-OS, SENTINEL, WORKSPACE-SHELL, WORKSPACE-CONTINUITY, ONBOARDING, SUBSCRIPTIONS, SENTINEL-KNOWLEDGE-GRAPH, GENESIS-V2-BLUEPRINT, TRADEW-ASSISTANT, SECURITY-AUTHORIZATION. Dated 2026-07-14 through 2026-07-26 (SECURITY-AUTHORIZATION.md and TRADEW-ASSISTANT.md are the newest, 07-26). This is the canonical per-subsystem spec set, actively maintained (newest file post-dates `docs.zip`'s snapshot — see §2). |

### `docs/README.md` — STALE
Only 9 lines. Describes `docs/` as **empty**, listing only `product/` (wrong filenames — `TradeW-PRD.docx` etc., which don't exist), `build-plan/` (doesn't exist in the live tree), and `design-reference/` with `TradeW-Platform-v0.2.html`/`v0.4.html` (neither exists; design-reference actually holds `DESIGN-SYSTEM.md`). This file was written at the very start of the project (zip timestamp 2026-07-14 20:27) and never updated as `handbook/`, `product-architecture/`, `ai/`, and `Trading Books/` were added. **This is the single clearest "stale doc" finding in the whole audit** — it actively misleads a reader about what's in the folder it's the front door for.

### `docs/APPLICATION-STATUS.md` — CURRENT
Dated **2026-07-25**, explicitly labeled a "living status doc," cross-links `ARCHITECTURE.md` and `REPOSITORY_INVENTORY.md`, uses a clear ✅/⚠️/🧱/❌ legend, and reads like it's actively maintained (last line: "This file is meant to be updated as work lands — not regenerated from scratch"). Content is specific and falsifiable (e.g., "zero automated tests," named files/line counts). This is the most trustworthy status doc found in the repo — **with one caveat**: it directly contradicts the root `README.md`'s newer (2026-07-29) claim of "112 automated tests" and "80% complete" (see §4/§5). One of the two is now wrong/stale; APPLICATION-STATUS.md is more likely current given its detail and explicit self-description as living, but this conflict should be resolved by whoever owns these docs.

---

## 2. `docs.zip`

- **Location:** repo root, next to live `docs/`. Size 523,360 bytes (523KB). Contains 66 entries (directories + files).
- **Contents:** verified via `unzip -l` and full `diff -rq` against live `docs/`. The zip is a near-exact snapshot of `docs/` **as of 2026-07-27 03:23**, missing only:
  - `docs/build-plan/` (an empty directory that doesn't exist in the live tree either — a leftover from the original `docs/README.md` plan)
  - `docs/product-architecture/SECURITY-AUTHORIZATION.md` (added to live docs after the zip was made)
  - The entire `docs/Trading Books/` folder (14 PDFs) — never included in the zip at all.
- **Verdict:** this is a stale point-in-time backup/duplicate of `docs/`, already one file behind live and destined to keep drifting. No unique content — everything in it is a strict subset of the live `docs/` tree. **Safe to archive or delete**; if provenance matters, move to `archive/` per the repo's existing archival convention (see `archive/README.md`) rather than leaving it at root next to the real `docs/`.
- Note: an unrelated second `docs.zip` exists at `.claude/worktrees/ai-reasoning/docs.zip` — inside a git worktree, out of scope for this audit.

---

## 3. `knowledge/` vs `knowledge-base/`

**Verdict: genuinely distinct, well-documented, non-overlapping purposes — not a confusing duplicate.** `knowledge-base/README.md` even contains an explicit disambiguation section titled "This is not `knowledge/`" with a comparison table, because the authors anticipated the confusion.

| | `knowledge/` | `knowledge-base/` |
|---|---|---|
| What it is | Obsidian vault — dated engineering changelog (Decisions/Patterns/Gotchas/Research/Agents/Plans/API folders, one note per event, e.g. `2026-07-23 - Sentinel not working was four stacked config+build faults.md`) | Static YAML ontology of ~65 market concepts across 15 domains (options, risk-management, trading-psychology, market-microstructure, macroeconomics, derivatives, glossary, etc.) |
| Audience | Developers / Claude Code working on the repo | Sentinel's runtime (seeded into Postgres) and end users |
| Format | Markdown notes with frontmatter + `[[wikilinks]]` | `<concept-id>.yaml` per file, strict schema (id/domain/relations/confidence/etc.) |
| Governance | `CLAUDE.md` Rule 4 | `SENTINEL-KNOWLEDGE-GRAPH.md`; validated via `npm run ontology:validate` |
| Runtime wiring | Never wired into production | Seeded into Postgres, read on every Sentinel observation |

Spot-checked: `knowledge/Decisions/2026-07-17 - Obsidian Knowledge Layer adopted.md` and `knowledge/Gotchas/...` (dated engineering notes) vs. `knowledge-base/options/max-pain.yaml`-style concept files (structured market definitions) — confirmed zero content overlap, different file formats entirely (Markdown prose vs. structured YAML).

One additional wrinkle inside `knowledge/`: a nested `knowledge/sentinel-learning/` sub-vault (its own Obsidian config, 17 numbered category folders 00–16 e.g. "01 Concepts," "08 Options," "10 Books," "13 Research," plus `INGESTION-ARCHITECTURE.md`) was added later (`knowledge/Decisions/2026-07-30 - Sentinel Learning Vault created (upstream authoring layer).md`) as an "upstream authoring layer" — i.e., a *third*, newer knowledge surface where humans draft content that later gets promoted into `knowledge-base/`'s canonical YAML. This is documented as intentional (an authoring/staging layer feeding the canonical ontology) rather than a duplicate, but it's worth knowing a third similarly-named tree exists if doing further cleanup — most of its category folders currently contain only `README.md` stubs (no real content yet), so it reads as scaffolding, not populated duplicate content.

---

## 4. Root-level doc overlap

| Doc | Size | mtime | Purpose | Overlap / staleness |
|---|---|---|---|---|
| `ARCHITECTURE.md` | 21KB | 2026-07-21 | "Final Target Architecture" — 10 sections of design *rules* (monorepo boundaries, NestJS↔Python comms, AI agent split, n8n, shared libs, env/deploy, observability, dependency graph, open items). | Canonical and still cited as current by `docs/APPLICATION-STATUS.md`. Distinct from the inventory docs below — this is *prescriptive* (how it should be), they are *descriptive* (what exists file-by-file). No direct duplicate. |
| `REPOSITORY_INVENTORY.md` | 154KB | 2026-07-25 | "Repository Inventory (A→Z)" — exhaustive file-by-file audit: folder tree, every important file/module, config files, backend (modules/services/controllers/routes/guards), frontend (pages/components/hooks/stores), database (enums/tables/migrations), AI system, trading system, §17 "Missing Pieces." | Same day as `APPLICATION-STATUS.md`, and explicitly cross-linked by it as "the full file-by-file audit." Functions as the detailed backing document for the higher-level status doc — legitimate companion, not a duplicate of `ARCHITECTURE.md` (inventory vs. rules). |
| `TRADEW_DEVELOPER_REFERENCE.md` | 99KB | 2026-07-23 | "TradeW Developer Reference" — architecture overview, repo map, **complete feature registry**, screen documentation, backend/database/API documentation, dependency graph, **§11 Dead Code Audit**, environment docs. | **Strongly overlaps with `REPOSITORY_INVENTORY.md`** — both catalog the same services/api modules, DB tables, API endpoints, and dependency graphs, at similar exhaustive depth, 2 days apart in age. Neither `APPLICATION-STATUS.md` nor `REPOSITORY_INVENTORY.md` reference this file, suggesting it was superseded by `REPOSITORY_INVENTORY.md` and left behind rather than actively maintained. **Prime candidate for archiving** — two ~100–150KB "catalog the whole repo" docs is redundant; keep the newer/more-cross-referenced one (`REPOSITORY_INVENTORY.md`). |
| `PROJECT_TEST_AUDIT.md` | 74KB | 2026-07-23 | "Comprehensive QA & Product Audit Report" — overall readiness score (62%), architecture/database/API health, feature-by-feature manual test results per page, security/performance/accessibility findings, technical debt. | Despite the name, this is a **manual QA/product audit**, not an automated-test doc — its "Feature-by-Feature Testing Results" and "Working Features Summary" sections cover the same ground as `docs/APPLICATION-STATUS.md`'s ✅/⚠️/❌ sections, just two days older and in a different (percentage-score) format. Not cross-referenced by `APPLICATION-STATUS.md`. Reads as a **superseded predecessor** — the "62% overall readiness" framing looks out of date next to the newer, more precise living-status doc. Worth keeping as a point-in-time QA snapshot/archive, but should not be treated as current. |
| `SENTINEL_MASTER_PLAN.md` | 22KB | 2026-07-26 | "Product Vision & Intelligence Blueprint" for Sentinel — 12 architectural modules (Market Intelligence, Strategy, Historical Intelligence, News, Learning, Risk, Confidence, Timeline, State Machine, Vocabulary, EOD Analysis, Continuous Improvement), plus a **future-dated Gantt roadmap starting 2026-08-01**. | This is an aspirational/vision document, not a status report — no "last updated," self-described as "Canonical Product Vision." Overlaps in subject matter with `docs/handbook/06-09` (sentinel-foundations/departments/engines/runtime) and `docs/product-architecture/SENTINEL.md`, but at the vision/roadmap level rather than implementation level, so not a strict duplicate. `knowledge/Patterns/2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service).md` confirms this plan was subsequently acted on (partially) — so it's a live-ish planning doc, not dead. |
| `SENTINEL_BRAIN_PROGRESS.md` | 4KB | 2026-07-16 | Status tracker for just the "Brain" subsystem (Persistent Knowledge Brain, Concept Learning, Research Engine, Pattern Recognition, Historical Similarity, Explainability, etc.), with a 78% progress bar. | **Older and narrower** than `SENTINEL_MASTER_PLAN.md` (different scope: Brain subsystem only vs. whole Sentinel product) but its content (which Brain layers are ✅ vs ⚠️ first-pass vs ❌) is **now duplicated and superseded by `docs/APPLICATION-STATUS.md`**'s "Sentinel (AI safety layer)" section, which restates the same "Persistent Knowledge Brain... all real, all degrade gracefully," "Continuous Learning from Outcomes... first-pass only... self-documented in SENTINEL_BRAIN_PROGRESS.md" (APPLICATION-STATUS.md even cites this file by name). Not a pure duplicate — APPLICATION-STATUS.md explicitly treats it as a source it summarizes — but at 10 days older it is the more stale of the two and could be merged/retired once its unique detail is folded in. |
| `implementation_plan.md` | 6KB | 2026-07-26 | **Not a TradeW architecture/product doc** — it's a planning artifact for a "Phase 2" documentation-generation task (13 audit deliverables: `01_FEATURE_INVENTORY.md` … `13_PROJECT_COMPLETION_SCORECARD.md`), with output paths pointing to `C:/Users/vivek/.gemini/antigravity-ide/brain/...` — **an absolute path on a different machine/tool (Gemini Antigravity IDE), outside this repo entirely.** This looks like a stray orphaned planning artifact from a prior AI-tool session that got committed into the repo root by accident, not a maintained project doc. **Strong candidate for deletion or archiving** — it has no relevance to anyone reading the repo today and its target paths don't even exist in this environment. |

**Summary of overlap:** `REPOSITORY_INVENTORY.md` and `TRADEW_DEVELOPER_REFERENCE.md` are the clearest true duplicate pair (both exhaustive whole-repo catalogs). `PROJECT_TEST_AUDIT.md` and `SENTINEL_BRAIN_PROGRESS.md` are both superseded-in-spirit by the newer `docs/APPLICATION-STATUS.md`, which has absorbed/cites their content. `SENTINEL_MASTER_PLAN.md` and `ARCHITECTURE.md` are legitimately distinct (vision/roadmap vs. design rules) and not duplicates. `implementation_plan.md` isn't really a project doc at all and is the single cleanest deletion candidate of the batch.

---

## 5. Root `README.md` (62KB)

Headers show a huge single-file doc: Overview, Architecture, Repository Structure, Technology Stack, Features (Implemented/Partial/Not-yet), Quick Start, **Setup Guide** (full env-var reference for every service, DB setup, build/dev commands), Database, AI Architecture, Development Workflow, HTTP API (selected routes), **Project Status** (dated "Verified 2026-07-29"), Roadmap.

This single README duplicates content that has dedicated homes elsewhere in the repo:
- "Architecture" / "AI Architecture" sections overlap `ARCHITECTURE.md` and `docs/handbook/05-system-architecture.md` / `18-ai-architecture.md`.
- "Setup Guide" (env vars, DB setup, build commands) overlaps `docs/handbook/14-monorepo.md`, `16-backend-architecture.md`, `17-database.md`, `22-devops.md`.
- "Database" section overlaps `docs/handbook/17-database.md` and `REPOSITORY_INVENTORY.md` §7.
- "Project Status" / "Roadmap" sections directly overlap `docs/APPLICATION-STATUS.md` — and **conflict with it**: README (2026-07-29) claims **"~80% complete"** and **"Security hardening + 112 automated tests"**, while `docs/APPLICATION-STATUS.md` (2026-07-25, only 4 days older) states **"there are zero automated tests anywhere in the repository"** as the single biggest risk. These two "current" docs give a reader materially different — and contradictory — pictures of test coverage. This is the most actionable inconsistency found in this audit: either tests were added between 07-25 and 07-29 and `APPLICATION-STATUS.md` needs updating, or the README's "112 automated tests" claim is wrong/aspirational and needs correcting. (A `knowledge/` note dated 2026-08-03, "Test infrastructure pass (runners made discoverable, money math covered)," suggests test infra work happened *after* both these docs — so both may now be stale on this specific point.)

**Recommendation:** README.md should be trimmed to a short orientation (what TradeW is, quick start, pointers to `docs/handbook/` and `docs/APPLICATION-STATUS.md`) rather than re-hosting full architecture/setup/status content that already lives — and drifts independently — in `docs/`.

---

## Bottom-line recommendations

1. **Delete/archive `docs.zip`** — confirmed stale (missing `SECURITY-AUTHORIZATION.md`) strict-subset duplicate of live `docs/`. Move to `archive/` if provenance is wanted, per the repo's own archival convention.
2. **Rewrite or delete `docs/README.md`** — actively wrong about what's in its own folder (describes it as empty; lists files that don't exist; omits `handbook/`, `product-architecture/`, `ai/`, `Trading Books/` entirely).
3. **Archive `TRADEW_DEVELOPER_REFERENCE.md`** — true duplicate of `REPOSITORY_INVENTORY.md` at similar depth; the latter is newer and is the one actively cross-referenced by the living status doc.
4. **Archive `implementation_plan.md`** — not a TradeW doc; a leftover artifact from an external AI tool session with output paths outside this repo/machine.
5. **Reconcile the test-coverage contradiction** between root `README.md` ("112 automated tests," 80% complete, 2026-07-29) and `docs/APPLICATION-STATUS.md` ("zero automated tests," 2026-07-25) — pick one source of truth and update the other.
6. **Consider retiring/merging `PROJECT_TEST_AUDIT.md` and `SENTINEL_BRAIN_PROGRESS.md`** into `docs/APPLICATION-STATUS.md`, which has effectively superseded both (already cites `SENTINEL_BRAIN_PROGRESS.md` by name for one specific claim) — or clearly mark them as dated snapshots rather than living docs.
7. **Trim root `README.md`** down from 62KB to an orientation/quick-start doc that links to `docs/handbook/` and `docs/APPLICATION-STATUS.md` instead of duplicating their content.
8. **`knowledge/` vs `knowledge-base/` is fine as-is** — no action needed; the distinction is real, deliberate, and already self-documented against confusion. (Just be aware of the newer third tree, `knowledge/sentinel-learning/`, mostly still empty scaffolding, if doing further consolidation.)
