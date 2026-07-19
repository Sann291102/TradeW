# Explainability — Core Architectural Principle

Status: design, pre-implementation. Elevated to a core principle by the Genesis v2 direction update (§12). Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §2.6.

## 1. The principle

**Every AI-generated conclusion must be explainable.** This is not a UI feature bolted onto answers — it is an architectural constraint on how agents produce output. An agent that can produce a conclusion but not its supporting structure is incomplete and must not ship.

This applies with full force to **every premium (Sentinel) answer**, and to TradeW AI's analytical answers where they make a substantive claim. Navigation/command responses (`TRADEW-ASSISTANT.md`) are exempt — they're not analytical claims.

## 2. The explainability contract

Every premium conclusion must be able to surface, on demand:

| Element | What it shows | Backed by |
|---|---|---|
| **Reasoning** | the chain of inference from evidence to conclusion | the agent's structured output, not a post-hoc rationalization |
| **Supporting evidence** | the specific data points/observations used | Research Vault records (`RESEARCH-VAULT.md` §5) |
| **Related historical examples** | prior comparable situations | Knowledge Graph historical-example nodes (`KNOWLEDGE-GRAPH.md` §3) |
| **Confidence** | how sure, and why | the Validation Engine's confidence score (`CONTINUOUS-LEARNING-PIPELINE.md` §2) or the agent's own calibrated estimate |
| **Data sources** | provenance of every input | source/timestamp on each Research record |
| **Why the conclusion changed** | if this contradicts or updates a prior conclusion, what new evidence caused the change | the versioned history of the underlying Knowledge nodes (`TRADEW-OS.md` §2.7) |

The last row is what the versioning rule (knowledge is never deleted, only superseded with a link back) exists to make possible — "why did your view change?" is answerable only because the prior version and the edge to it still exist.

## 3. This is why the memory architecture is shaped the way it is

Explainability is not achievable as an afterthought on top of an opaque model call. It's the *reason* for several existing design decisions, now made explicit as their shared purpose:

- **Research/Knowledge split** (`RESEARCH-VAULT.md`) — so evidence is traceable separately from conclusions.
- **Mandatory provenance** on every Research record — so "data sources" is always answerable.
- **Relationship-linked graph, no isolated nodes** — so "related historical examples" is a graph traversal, not a guess.
- **Versioned, never-deleted knowledge** — so "why did this change" has a real audit trail.
- **Confidence scoring in the pipeline** — so "how sure" is a computed value, not a vibe.
- **Sentinel's Compliance & Audit agent** (`SENTINEL.md` §2) — already logs every observation with evidence and a SEBI label; the explainability contract is the user-facing read side of the same audit substrate.

## 4. Output shape

Premium agent responses are structured objects, not free text: a `conclusion` plus an `explanation` block carrying the six elements in §2. `apps/web` renders the conclusion prominently and the explanation as a progressively-disclosed "show reasoning / evidence / sources" panel — the user sees the answer immediately and can drill into *why* without a second round-trip. Exact schema is an implementation-time decision; the required *fields* are fixed by §2.

## 5. Compliance alignment

Explainability and TradeW's observation-only posture reinforce each other: an explained observation ("here's what I see, here's the evidence, here's my confidence, consider waiting for confirmation") is definitionally not a directive instruction. The explainability contract makes the "analyze, never advise" rule (`TRADEW-OS.md` §1) auditable — every premium output can be inspected to confirm it presented evidence and reflection, not a command.

## 6. Non-goals

- Not required for navigation/search/app-control responses (not analytical claims).
- Not a requirement to expose raw model internals or chain-of-thought tokens — "reasoning" means the structured, presentable inference the agent commits to, at a level a trader can evaluate, not a token dump.
