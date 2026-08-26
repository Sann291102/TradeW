import { defineConfig } from 'vitest/config';

/**
 * The paper-execution INTEGRATION harness — separate from `vitest.config.ts`.
 *
 * These specs require a real Postgres (they run the actual services against
 * actual SQL: real intents, real idempotency-key uniqueness, real lifecycle
 * transitions). The unit config deliberately needs nothing running, so this one
 * is kept apart and is NOT part of the default CI unit job.
 *
 * Run it with a database:
 *
 *   DATABASE_URL=postgresql://…/tradew_test \
 *     npx vitest run --config vitest.integration.config.ts
 *
 * The two things genuinely external to this feature — Sentinel's decision and
 * the Dhan market feed — are faked deterministically. Everything the feature
 * OWNS (the loop, the policy, idempotency, persistence, the lifecycle) is real.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.e2e.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A DB-backed suite must not run in parallel against one schema.
    fileParallelism: false,
  },
});
