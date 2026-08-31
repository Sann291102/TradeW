import { defineConfig } from 'vitest/config';

/**
 * Sentinel's first test runner.
 *
 * Before this, `services/sentinel` had no vitest config at all — the only
 * executable checks were the `ts-node` harnesses in `scripts/`, which nothing
 * runs automatically. See
 * `knowledge/Patterns/2026-08-03 - Test infrastructure pass`.
 *
 * `include` is an allowlist, matching the convention `services/api` set: adding
 * a suite is a deliberate act, and this config can never start failing on code
 * it was never scoped to cover.
 *
 * Everything listed is pure or directly constructed — no Nest application
 * context, no Postgres, no network, no market data. `vitest run` needs nothing
 * running, which is what makes these checks meaningful in CI.
 */
export default defineConfig({
  test: {
    include: [
      // The compliance enforcer: rewrite directives, leave analysis alone.
      'src/vocabulary/vocabulary.spec.ts',
      // The surfacing gate: what must be said, and what must stay silent.
      'src/sentinel-intelligence/synthesis/gate.spec.ts',
      // Request understanding, including four production parsing regressions.
      'src/sentinel-intelligence/understanding/request-parser.spec.ts',
      // Retrieval and the citation guarantee.
      'src/sentinel-intelligence/knowledge/knowledge-index.spec.ts',
      // The continuous watch loop: cost controls and base-rate integrity.
      'src/sentinel-intelligence/watch/market-watch.spec.ts',
      // Chart geometry — the maths behind every drawn annotation.
      'src/sentinel-intelligence/visual/geometry.spec.ts',
      // Learned TradingView specs: validation, matching, and drawing replay.
      'src/sentinel-intelligence/visual/drawing-spec.spec.ts',
      // The reasoning-engine merge point: does the orchestrator correctly
      // judge agreement with SentinelIntelligence's cached background verdict.
      'src/orchestrator/cross-validation.spec.ts',
      // The publication gate: the four conditions that decide whether anything
      // reaches a trader at all. Confidence alone never publishes.
      'src/orchestrator/publication-gate.spec.ts',
      // The validated event contract that leaves this service for notification
      // channels. Asserts the two properties a comment cannot hold: an event
      // structurally carries no direction, and a repeated poll dedupes.
      'src/events/sentinel-event.spec.ts',
      // Phase 2 — market structure, liquidity behaviour and the
      // continuation/reversal read that Sentinel reasons about.
      'src/intelligence/market-structure.spec.ts',
      // Phase 3 — the per-strategy lifecycle machine and option-chain context.
      'src/strategy/strategy-lifecycle.spec.ts',
      // Phase 4 — the learned per-regime reliability arithmetic.
      'src/improvement/adaptive-calibration.spec.ts',
      // Phase 5 — reasoning rendered as chart annotations.
      'src/sentinel-intelligence/visual/reasoning-annotations.spec.ts',
      // Phase 6 — do the independent evidence dimensions agree, and which
      // ones have no data at all.
      'src/orchestrator/institutional-cross-validation.spec.ts',
      // The market clock. This file existed for months but was never in this
      // allowlist, so its assertions — including the pinned KNOWN-GAP ones
      // recording that the clock is day-of-week and holiday blind — never
      // executed. Added during the pre-live-validation pass: an untested clock
      // is not something to take into a live session. Those KNOWN-GAP
      // assertions were inverted on 2026-08-16 when clock unification landed.
      'src/market-clock.spec.ts',
      // The CE/PE legs beside the underlying — the arithmetic behind the
      // workspace's other two charts, which the engine did not read until
      // 2026-08-16. Includes the Rule 2 guard: no note it emits may contain
      // directive language.
      'src/intelligence/contract-alignment.spec.ts',
      // The internal api→sentinel auth boundary: fails closed on a weak/unset
      // service token, constant-time compare (2026-08-10 assessment).
      'src/service-token-guard.spec.ts',
      // The market-data boundary, added with the 2026-08-17 outage fix. Pins the
      // one property whose absence caused it: an upstream FAULT and an absence of
      // DATA are different facts, and Sentinel must never report one as the
      // other. See SENTINEL_ROOT_CAUSE_AND_PERMANENT_FIX.md.
      'src/market-data/candle-market-data.spec.ts',
      // Detection timestamps: market-event time vs the scan's own clock. Added
      // with the autonomy pass, where the session timeline was found stamping
      // every setup with the time of the browser poll that noticed it.
      'src/intelligence/strategy-engine.spec.ts',
      // The autonomy wiring itself: `/observe` putting a symbol under watch,
      // and the deferred, idempotent corpus warm-up that lets the background
      // watch reason without a human calling `/intelligence/reason` first.
      'src/sentinel-intelligence/sentinel-intelligence.spec.ts',
      // The three-strike evaluation behind the paper-execution loop. Pure over
      // an option chain — no Nest, no network. Pins the two properties whose
      // absence would be silently expensive: a CALL's in-the-money strike sits
      // BELOW spot (getting it backwards selects the opposite exposure to the
      // published read), and an UNPRICED leg is never confused with one priced
      // at zero.
      'src/execution/strike-candidates.spec.ts',
      // The outcome tagger's own scheduler, added 2026-08-21. Pins the reason
      // it exists: `MarketWatchService` writes occurrences on a timer and does
      // not call `/observe`, so tagging that depended on request traffic let
      // the untagged backlog grow all session — and an untagged occurrence is
      // invisible to the base rates the live-performance gate reads.
      'src/brain/outcome-learning.spec.ts',
      // The ten reasoning agents and the dispatcher that guarantees a verdict
      // for every subtask. Pins the invariants stated in their own headers:
      // abstention on missing input, no knowledge evidence without a citation,
      // and a thrown agent becoming an abstention rather than a failed run.
      'src/sentinel-intelligence/agents/agents.spec.ts',
      'src/sentinel-intelligence/agents/agent-registry.spec.ts',
      // Decomposition: which agents a given intent routes to, and the skip
      // paths that keep an agent from being asked a question it has no data for.
      'src/sentinel-intelligence/understanding/task-decomposer.spec.ts',
      // ---- Autonomous paper agents (2026-08-30) --------------------------
      // The provenance chain, checked against the knowledge base ON DISK:
      // every concept an agent strategy cites must exist, every evidence key
      // must have a reader, every rule must resolve. A renamed concept breaks
      // a strategy's provenance silently everywhere else — here it fails.
      'src/execution/strategy-knowledge.spec.ts',
      // Data quality: how old the bars actually were. The gate that separates
      // "live read" from "stored history the provider fell back to".
      'src/execution/data-quality.spec.ts',
      // Index direction, derived from the index alone. Pins the property the
      // whole two-read design rests on: it never consults an option premium,
      // and a split vote is `unclear` rather than the bigger half.
      'src/execution/index-direction.spec.ts',
      // The important-information-only filter: a strategy reads what it
      // declares and nothing else, and a stance is always relative to the
      // direction asked about.
      'src/execution/evidence.spec.ts',
      // The agent-facing evaluation as a whole, including the refusal when the
      // index direction and the published option side disagree.
      'src/execution/execution-evaluation.spec.ts',
    ],
    environment: 'node',
    // Deterministic and clock-injected throughout: a slow test is a real hang,
    // not a busy machine.
    testTimeout: 5_000,
  },
});
