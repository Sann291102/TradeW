import { defineConfig } from 'vitest/config';

/**
 * ai-core's first test runner.
 *
 * `include` is an allowlist, matching the convention `services/api` and
 * `services/sentinel` set: adding a suite is a deliberate act, and this config
 * can never start failing on code it was never scoped to cover.
 *
 * Everything listed is pure — the cognition network takes all of its
 * infrastructure through injected ports, so the whole four-layer loop runs with
 * three small fakes and no database, no network and no clock it was not handed.
 */
export default defineConfig({
  test: {
    include: [
      // The four-layer network: gating, corroboration, and the learning rule.
      // The rule is the part worth pinning — a weight update that silently does
      // nothing produces a console that looks alive and never learns.
      'src/cognition/cognition.spec.ts',
    ],
    environment: 'node',
    testTimeout: 5_000,
  },
});
