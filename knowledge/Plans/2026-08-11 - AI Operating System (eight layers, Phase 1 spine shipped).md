# AI Operating System — eight layers, Phase 1 spine shipped

Date: 2026-08-11
Spec: [`docs/product-architecture/AI-OPERATING-SYSTEM.md`](../../docs/product-architecture/AI-OPERATING-SYSTEM.md) — **binding**
Related: [[Patterns/2026-08-11 - Landing page as decision brief + mascot as shared agent identity]] · `docs/product-architecture/TRADEW-ASSISTANT.md`

---

## 1. The reframe

Product direction, 2026-08-11: TradeW's AI is **not a chat window**. It is an
operating layer over the product — you speak or type in ordinary language and it
drives the application the way a competent colleague at your keyboard would,
including the chart itself, explaining as much or as little as you want, and
stopping to ask before anything consequential.

Eight layers: conversation → planner → execution → chart agent → memory →
voice → narration → safety (which wraps all of it).

## 2. Ground truth found while scoping (verified in code, not from docs)

- **`packages/ai-core` is real** — 31 modules: `agents/`, `brain/`, `context/`,
  `domain/`, `graph/`, `memory/`, `news/`, `prompts/`, `providers/`, `rag/`,
  `research/`, `telemetry/`, `tools/`. `ANTHROPIC_API_KEY` is configured.
- **`services/tradew-ai` is an empty stub** — zero `.ts` files. Nothing exposes
  `ai-core` to `apps/web`. This is the gap, not the LLM work itself.
- The shipped assistant is a deterministic resolver with **no planner, no
  memory, no chart access, and no confirm tier** — only refuse-or-execute.

## 3. Three decisions taken (binding)

| Decision | Chosen | Why it matters later |
|---|---|---|
| Chart reading | **Structured JSON *and* screen capture, on every read** | Structured is authoritative for anything numeric; the capture carries drawings/layout/appearance. Where they disagree on a number, **JSON wins and the gap is a bug to log** — never averaged. Image-token cost accepted deliberately. |
| Brain hosting | **Stand up `services/tradew-ai`**, reached via `services/api` | `ARCHITECTURE.md` §1's one-public-ingress. The app already carries one deviation (the Dhan bridge); the component that hands user context to an LLM is the wrong place for a second. |
| Build order | **Spine first** (safety, modes, memory, planner) | Makes the system safer before more capable — the right order for anything touching a trading workspace. Needs no key, no service, no network. |

## 4. Phase 1 — shipped

New: `lib/assistant/planner.ts`, `safety.ts`, `narration.ts`, `planner.test.ts`.
Changed: `useAssistant.ts`, `FloatingAI.tsx`, `workspaceStore.ts`, `types.ts`.

**Planner.** One sentence → ordered steps. "Open research then show the option
chain" now runs both; previously it ran the first and silently dropped the rest.

> **The splitting trap.** The obvious implementation splits on "and". That is
> wrong: *"price of nifty and banknifty"* is ONE quote lookup for two symbols.
> Split it and the second fragment resolves as **open the BANKNIFTY chart** — the
> assistant navigates away from your screen because you asked for two prices.
> So: strong connectives (`then`, `after that`, `;`) always split; a bare `and`
> splits **only when a known command verb follows**. Pinned by test.

> **Refusal poisons the whole plan.** *"Open the chart then buy 50 lots"* must not
> open the chart and drop the rest — a user who sees the chart open reasonably
> concludes the whole instruction ran. Boundaries are checked on the whole
> utterance first and short-circuit splitting entirely. Pinned by test.

**Safety (the missing middle).** `domain-guard.ts` already handled *refusal*.
There was no tier for "allowed, but ask first". Now:

- `free` — navigate, quote, theme, panels: reversible in one click, run immediately.
- `confirm` — `applyLayout` (**destructive by omission**: nobody says "delete my
  panels", but applying a layout replaces the arrangement), and any plan ≥5 steps.
- `refuse` — unchanged, and there is deliberately **no order variant to gate**.

The gate reads **the plan, not the sentence** — intent is trivially easy to
phrase innocently ("just tidy things up"), a plan is a concrete list.
Deliberately *not* confirming reversible actions: prompt fatigue trains users to
click through, which makes the gate worse than useless when it finally guards
something real.

**Narration modes** — teaching / normal / silent, persisted in `workspaceStore`.
Two rules: silent means *don't narrate*, never *don't record* (`rawSteps` always
populated); and silent **never** silences the safety gate — a confirmation is not
narration. Teaching-mode copy is about the **platform**, never the market, so it
can't become a side door to un-guardrailed commentary.

**Memory (first slice)** — `assistantMode` persisted. Preferences are learned by
**asking, never by inference**: an assistant that changes your workspace from a
pattern you never confirmed is indistinguishable from a bug.

## 5. Verified

77/77 tests (38 new), typecheck clean, and driven in a real signed-in browser
session: multi-step trace, confirm prompt + cancel leaving state untouched, and
all three narration modes.

## 6. Open findings (not fixed, not mine to decide)

- **Sentinel panel claims "ACTIVE PRO · actively observing"** on `/trade` while
  `/api/sentinel/observe` returns **403** for an unentitled account. The gate is
  working; the UI is asserting something untrue on top of it.
- The two-market-data-clients split is still unresolved — see the related note §6.

## 7. Next

Phase 2 (chart control surface) → Phase 3 (`services/tradew-ai` + brain) →
Phase 4 (Sentinel over the visible chart, durable recall) → Phase 5 (voice out,
continuous mode, barge-in). Phase 2 and 3 are independent and can run in either
order; both need Phase 1, which is now in.
