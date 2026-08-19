import { defineConfig } from 'vitest/config';

/**
 * `include` is an allowlist, matching the convention services/api and
 * services/sentinel set: adding a suite is a deliberate act, and this config can
 * never start failing on code it was never scoped to cover.
 *
 * Everything listed is pure — no Nest context, no Postgres, no network. That is
 * what makes these checks meaningful in CI, and it is why the catalogue was
 * written dependency-free.
 */
export default defineConfig({
  test: {
    include: [
      // The security boundary: the only place an outbound URL is composed, and
      // the only part of it a caller influences.
      'src/catalogue/filing-datasets.spec.ts',
      // Upstream refusal detection — NSE refuses with HTML under HTTP 200, so
      // "did this succeed" cannot be decided on status alone.
      'src/ingestion/refusal.spec.ts',
      // The company universe's front door: 2,553 rows whose misparse would be
      // invisible downstream.
      'src/connectors/equity-list.parser.spec.ts',
      // Daily bars for the whole market. Pins the trap that would otherwise be
      // invisible: the bhavcopy filename is not the session date.
      'src/connectors/bhavcopy.parser.spec.ts',
    ],
    environment: 'node',
    testTimeout: 5_000,
  },
});
