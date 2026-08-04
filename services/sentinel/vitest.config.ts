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
      // Chart geometry — the maths behind every drawn annotation.
      'src/sentinel-intelligence/visual/geometry.spec.ts',
      // Learned TradingView specs: validation, matching, and drawing replay.
      'src/sentinel-intelligence/visual/drawing-spec.spec.ts',
    ],
    environment: 'node',
    // Deterministic and clock-injected throughout: a slow test is a real hang,
    // not a busy machine.
    testTimeout: 5_000,
  },
});
