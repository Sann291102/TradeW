import { defineConfig } from 'vitest/config';

/**
 * market-data's first test runner.
 *
 * `include` is an allowlist, matching the convention `services/api`,
 * `services/sentinel` and `packages/ai-core` set: adding a suite is a deliberate
 * act, and this config can never start failing on code it was never scoped to
 * cover.
 *
 * Everything listed is pure — the reliability layer takes its clock, its
 * credential source and its upstream call as injected functions, so the whole
 * 2026-08-17 failure sequence is reproducible with no network, no database and
 * no Dhan account.
 */
export default defineConfig({
  test: {
    include: [
      // The 2026-08-17 Sentinel outage, as executable regressions: credential
      // lifecycle under Dhan's 24h regulatory cap, fault-vs-absence
      // classification, and the load bounding that stops one dead credential
      // becoming a metered-API retry storm.
      'src/providers/dhan/dhan-reliability.spec.ts',
    ],
    environment: 'node',
    testTimeout: 5_000,
  },
});
