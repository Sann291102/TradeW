import { defineConfig } from 'vitest/config';

/**
 * The DB-backed execution suite. SEPARATE from `vitest.config.ts`, deliberately.
 *
 * That file opens by promising "`vitest run` needs nothing running" — no
 * database, no Nest context, no network — and every suite in it holds to that.
 * Adding a suite that requires Postgres would quietly break the promise for
 * every contributor and every CI job that runs `npm test`, and the failure
 * would look like a broken test rather than a missing dependency.
 *
 * So this is its own command:
 *
 *     npm run test:integration -w @tradew/api
 *
 * with `DATABASE_URL` pointing at a database the migrations have been applied
 * to. The suite skips itself (rather than failing) when that variable is unset,
 * so running it without one is a no-op instead of a wall of connection errors.
 *
 * ## Why these tests need a real database at all
 *
 * Every property they assert is a property of a constraint, a transaction or a
 * read-then-act window: the idempotency guarantee IS the unique index on
 * `ExecutionIntent.idempotencyKey`, and the mid-pass disarm IS a second read
 * seeing a committed write from the first. A mock cannot have either — it can
 * only be written to agree with the test.
 */
export default defineConfig({
  test: {
    include: ['src/paper-execution/execution-integration.spec.ts'],
    environment: 'node',
    // Each test seeds its own user, instrument and profile with a random
    // suffix, so they do not collide — but they share one database, and the
    // concurrency test deliberately races two passes against it. Serial
    // execution keeps a failure attributable to the case that caused it.
    fileParallelism: false,
    // Longer than the unit suite's 5s: these open real connections and one case
    // runs two concurrent passes through the OMS.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
