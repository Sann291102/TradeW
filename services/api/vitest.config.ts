import { defineConfig } from 'vitest/config';

/**
 * Scoped deliberately narrow: only the discipline module's pure logic.
 *
 * This is the repo's first test runner. It is NOT an attempt to backfill
 * coverage across `services/api` — the rest of the codebase (order fill math,
 * margin, entitlements) remains untested and that is tracked separately. The
 * `include` below is an allowlist rather than a glob over `src/**` so adding a
 * suite is a deliberate act, and so this config can never start failing CI on
 * code it was never scoped to cover.
 *
 * Everything under test is pure: no database, no Nest context, no network,
 * no environment. `vitest run` needs nothing running.
 */
export default defineConfig({
  test: {
    include: [
      'src/discipline/discipline-limits.spec.ts',
      'src/discipline/market-calendar.spec.ts',
    ],
    environment: 'node',
    // The suite is deterministic and clock-injected; a slow test means a real
    // hang, not a busy machine.
    testTimeout: 5_000,
  },
});
