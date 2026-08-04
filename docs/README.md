# docs/ ⚪

Product, architecture, and reference documentation for TradeW. Rewritten
2026-08-04 during the monorepo consolidation pass — the previous version of
this file described `docs/` as empty and pointed at folders
(`build-plan/`) and a `CONSOLIDATION-PLAN.md` that no longer exist. This
version reflects what's actually here.

For live day-to-day status (what's built, what's stubbed, known issues), see
`APPLICATION-STATUS.md` in this directory — it's the one doc in this tree
meant to be re-read often, not written once.

## Layout

- **`handbook/`** — the engineering handbook, 28 numbered chapters
  (`00-front-matter.md` through `27-future-vision.md`) covering product
  requirements, system architecture, Sentinel's internals, the paper trading
  engine, database, security, testing, coding standards, and decision
  records. Start at `00-front-matter.md` if you're new to the codebase.

- **`product-architecture/`** — one design doc per subsystem or feature
  (agent architecture, market data, knowledge graph, Sentinel, subscriptions,
  onboarding, the TradingView workspace, and more — 23 files). Each is scoped
  to a single subsystem rather than the whole platform; see `handbook/` for
  the cross-cutting picture.

- **`product/`** — the product vision/business overview
  (`TradeW-Project-Vision-and-Business-Overview.{docx,pdf}`).

- **`design-reference/`** — `DESIGN-SYSTEM.md` (the current design-token/
  component reference — see also `docs/handbook/24-design-system.md` and the
  live implementation in `packages/ui`) and `prototype/README.md`, a pointer
  note rather than a live prototype.

- **`ai/`** — `DISTILLATION.md`, notes on AI-model distillation for
  financial data, related to the `ai-model-distillation-for-financial-data`
  work referenced elsewhere in project history.

- **`Trading Books/`** — 14 reference PDFs on trading strategy, price
  action, psychology, and market structure. Source material, not TradeW
  documentation — kept here for the team's/Sentinel's reference use, not
  because it describes this codebase.

- **`APPLICATION-STATUS.md`** — living status doc: what's built, what's
  partial, current known issues and risks. If you need to know "does X
  actually work right now," this is the file to check (and update) rather
  than any of the point-in-time docs above.

## A note on staleness

Handbook and product-architecture docs are dated per-file at the top; check
that date against recent commits before treating either as ground truth for
a fast-moving subsystem (Sentinel and the Admin Portal both changed
significantly around 2026-08-03/04). `APPLICATION-STATUS.md` is the doc most
likely to be current; root-level docs like `README.md`,
`REPOSITORY_INVENTORY.md`, and `ARCHITECTURE.md` (outside this directory)
can drift from actual code state between audits — cross-check claims against
the code or `APPLICATION-STATUS.md` rather than assuming any single doc is
authoritative.

Point-in-time snapshots that were superseded by this directory's living docs
(old test audits, progress reports, a stale zipped copy of `docs/` itself)
have been moved to `../archive/root-docs/` rather than deleted — see
`../archive/README.md` for what's there and why.
