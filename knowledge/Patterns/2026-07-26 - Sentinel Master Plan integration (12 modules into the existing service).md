# 2026-07-26 — Sentinel Master Plan integration (12 modules into the existing service)

`SENTINEL_MASTER_PLAN.md` became the target architecture for Sentinel. This note records how its 12 modules were folded into the **existing** `services/sentinel`, what was deliberately *not* built, and the design decisions a future agent would otherwise re-litigate.

Canonical spec: `SENTINEL_MASTER_PLAN.md`. Boundaries: [ARCHITECTURE.md](../../ARCHITECTURE.md), `docs/product-architecture/SENTINEL.md`. This note is the engineering record, not a duplicate of the spec.

## Where each module landed

| Module | Home | Reused or new |
|---|---|---|
| 1 Market Intelligence | `intelligence/market-intelligence.service.ts` | **extended** — all original signals kept verbatim, 10-profile classifier + trend analysis + option-chain read added |
| 2 Strategy Engine | `intelligence/strategy-engine.service.ts` + `strategy-rules.ts` | new capability |
| 3 Historical Intelligence | `brain/historical-similarity.service.ts` | **reused unchanged** |
| 4 News Intelligence | `intelligence/news-intelligence.service.ts` | **reused unchanged** |
| 5 Learning Intelligence | `explain/explain.service.ts` → Brain retriever | extended |
| 6 Risk Intelligence | `intelligence/risk-intelligence.service.ts` | new capability |
| 7 Confidence Engine | `confidence/confidence.engine.ts` | new capability |
| 8 Market Timeline | `timeline/timeline.engine.ts` | new capability |
| 9 Market State Machine | `state-machine/state-machine.service.ts` | new capability |
| 10 Vocabulary Rules | `vocabulary/vocabulary.ts` | new capability |
| 11 Market Close Review | `market-close/market-close-analysis.service.ts` | new capability |
| 12 Continuous Improvement | `improvement/continuous-improvement.service.ts` | new, reuses the strategy engine for replay |

`orchestrator/sentinel-orchestrator.service.ts` remains the only component that produces user-facing copy, and is the only place these are composed.

## Decisions worth not re-deriving

**Two independent surfacing gates, not one.** The Master Plan's confidence gate (≥85%) governs *market guidance*. The pre-existing composite-signal gate (SENTINEL.md §2-3: corroborating weight ≥0.7 across ≥2 signals) governs *behavioural and trap warnings*, and was kept. A revenge-trading warning must not be gated on a technical setup existing. Collapsing them into one gate is a regression, not a simplification.

**Session state is keyed, never global.** The state machine and timeline are singleton Nest providers serving every trader and symbol at once. Both key their state on `userId::symbol::istDateKey` with a 24h TTL prune. A single mutable `currentState` field (the shape a first pass had) leaks one trader's context into another's observation.

**The state machine never teleports.** When evidence points at a state that is not directly reachable, `nextHopToward` takes the shortest *legal* step via BFS over the transition table. The transition history stays a faithful session narrative instead of a set of jumps.

**The timeline is idempotent.** `/observe` is polled. `MarketTimelineEngine.record` no-ops on a duplicate `event`+`level`, or on a matching `dedupeKey` inside a 12-entry window. Without that, the "continuous narrative" is just the notification spam it was built to replace — and a confidence figure that ticks each poll would append a new line every time, which is why callers pass a stable `dedupeKey` rather than relying on exact text equality.

**Strategies are data, not code.** `strategy-rules.ts` is a registry of named predicates; a definition composes rule *names*. User YAML in `SENTINEL_STRATEGY_DIR` (or `<service>/strategies`) can therefore add strategies with no code change and no way to introduce arbitrary logic into the observe path. A file referencing an unknown rule is **rejected outright and logged** — dropping the bad rule silently would leave the trader with a strategy that tests less than they wrote.

**Detection is graded, not binary.** A setup with some rules confirmed is a *forming* setup (drives `STRATEGY_DETECTION`); only a full rule set with no invalidation is `validated` (drives `VALIDATION` → `SIDE_IN_FOCUS`). An invalidated setup is still reported with its confidence halved, so the trader sees that it fired and died.

**One weight governs both representations.** A risk factor's contribution to the composite gate is the same weight it carries inside the risk aggregate; a strategy's signal weight is derived from its own confidence. There is no second, hand-tuned number anywhere.

**Module 12 replays through the live engines.** `ContinuousImprovementService.replay` calls `composeSnapshot` + `StrategyEngineService.scan` per bar rather than reimplementing the rules — that is why `composeSnapshot` was extracted as a pure function from `MarketIntelligenceService.snapshot`. Look-ahead is avoided structurally (snapshot from `slice(0, i+1)`, outcome from `i+1` onward). VIX, breadth and the option chain are **held null during replay**, not back-filled with today's values, which would be exactly the look-ahead the design avoids. Weight moves are capped at ±20% of the factor's own weight and gated behind an 8-sample floor.

**Vocabulary enforcement is output-side.** `CORE_GUARDRAILS` in `packages/ai-core` constrains the *prompt*. `enforceVocabulary()` constrains the *output*, so a model that ignores its instructions still cannot emit a directive through Sentinel. Both the orchestrator's LLM path and `/explain` run through it, and violations are logged. Rewrites carry articles and verb agreement (`"a stop-loss" → "an invalidation level"`, `"I recommend" → "Sentinel observes"`) — a compliance-critical string that reads as broken English reads as a bug.

**The "Why?" payload is deterministic.** `ExplainService.buildWhy()` involves no model at all. Master Plan principle 7 requires a number the trader can audit, so the breakdown is reconstructed from the same factors that produced the score and cannot hallucinate a reason. `explain()`'s prose is the optional layer on top.

## What was deliberately not built

- **No forward economic calendar.** `MarketDataProvider.getNews(symbols, sinceHours)` is backward-looking. The News Risk factor measures *published* flow and says so in its own evidence rather than claiming a look-ahead it does not have. Master Plan Module 6 factor 5 is therefore partially served, honestly.
- **No order-book depth.** Not in the provider contract. Liquidity Risk is measured from traded volume and time of day, and states that limitation in its evidence.
- **No fabricated account data.** `AccountSummary` is optional end-to-end; `services/api` reads the real `PaperWallet` and returns `undefined` when there is none. A fabricated "0% utilised" would read as a low-risk account rather than an unknown one.
- **Module 12 item 4 does not re-seed.** It calls `OntologyLoaderService.load()` and reports counts/issues; writing concepts into `MemoryRecord` stays the `ontology:seed` script's job rather than growing a second seeding path that could disagree with it.

## Web layer: the derivation layer was demoted, not deleted

`apps/web/src/lib/sentinel/deriveContext.ts` used to *derive* the day classification and market-context dimensions from raw signals, because the backend had no such concept. It does now. The server's `marketProfile` / `confidence` are authoritative when present; the signal-derived path is retained **only** as the demo-mode/offline fallback. Two stale "Not enough data yet" dimensions (Trend state, Institutional participation) now answer from real data, and the `Trend Day` legend note claiming trend data was unavailable was removed.

`SentinelTimeline.tsx` and `DayClassificationCard.tsx` were extended rather than replaced — the timeline renders the real Module 8 narrative with a timestamp-strip fallback, and the "Why?" inspector uses the card's existing inline-disclosure pattern.

## Gotchas hit

- A first pass **overwrote** `sentinel-orchestrator.service.ts` with a 125-line stub, losing the composite gate, compliance recording, pattern-recognition persistence and the market-context call. Recovered with `git show HEAD:<path>`. Per [[../CLAUDE.md]] Rule 1, edit in place; when a rewrite is unavoidable, diff against `HEAD` before building on it.
- `Candle.timestamp` is a `Date`, not a number — `sessionSlice` and the ORB helpers rely on that.
- Servers are frequently UTC. Every "late in the session" and timeline-stamp decision goes through `market-clock.ts` (`Intl` with `Asia/Kolkata`), never `new Date().getHours()`.
- `archive/sentinel-timer-metrics.service.ts.txt` — a `TimerService` from the first pass, never registered or called. The timeline already timestamps everything; per-call latency belongs in a Nest interceptor. Archived per Rule 1, see `archive/README.md`.

## Verification

`services/sentinel` and `services/api` typecheck and `nest build` clean. A DI + behaviour smoke pass confirmed: all providers resolve, 8 strategies load, both risk and confidence factor weights sum to exactly 1, the state machine walked `MARKET_UNDERSTANDING → STRATEGY_DETECTION → VALIDATION` and **correctly refused** `SIDE_IN_FOCUS` at 69.2% against an 85% threshold, timeline dedupe suppressed a repeat, and the vocabulary enforcer stripped 5 directive phrases from a deliberately non-compliant string.

Pre-existing and unrelated: `apps/web/src/app/notifications/NotificationsClient.tsx` imports `Spinner` from `@tradew/ui`, which does not export it — the web typecheck fails on that alone.

Related: [[../Decisions/2026-07-21 - Sentinel Concept Knowledge Graph (living ontology)]], [[2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]], [[../Gotchas/2026-07-23 - Sentinel not working was four stacked config+build faults]]
