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
      // is not something to take into a live session.
      'src/market-clock.spec.ts',
      // The internal api→sentinel auth boundary: fails closed on a weak/unset
      // service token, constant-time compare (2026-08-10 assessment).
      'src/service-token-guard.spec.ts',
      // Detection timestamps: market-event time vs the scan's own clock. Added
      // with the autonomy pass, where the session timeline was found stamping
      // every setup with the time of the browser poll that noticed it.
      'src/intelligence/strategy-engine.spec.ts',
      // The autonomy wiring itself: `/observe` putting a symbol under watch,
      // and the deferred, idempotent corpus warm-up that lets the background
      // watch reason without a human calling `/intelligence/reason` first.
      'src/sentinel-intelligence/sentinel-intelligence.spec.ts',
    ],
    environment: 'node',
    // Deterministic and clock-injected throughout: a slow test is a real hang,
    // not a busy machine.
    testTimeout: 5_000,
  },
});
