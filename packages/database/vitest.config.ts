import { defineConfig } from 'vitest/config';

/**
 * Tests for the code this package ships at RUNTIME — currently one module, the
 * at-rest format for broker credentials.
 *
 * An explicit allowlist rather than a glob, matching services/api's config and
 * for the same reason: what belongs here is code where a mistake is an exposure
 * rather than a rendering bug, and that judgement should be made per file.
 *
 * Nothing here touches the database. The Prisma schema and its migrations are
 * exercised by the verification scripts under `scripts/`, which need a live
 * Postgres; this suite needs nothing running.
 *
 * `vitest` is hoisted to the workspace root by npm workspaces (declared by
 * services/api), which is why it is not a dependency here.
 */
export default defineConfig({
  test: {
    include: [
      // The one thing standing between a stolen database backup and working
      // brokerage credentials for every linked user.
      'src/credential-crypto.spec.ts',
    ],
    environment: 'node',
  },
});
