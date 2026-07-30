import { defineConfig } from 'vitest/config';

/**
 * Tests for the web app's build-time security configuration.
 *
 * Scoped, like services/api's config, to an explicit allowlist rather than a glob
 * — this is not a general test setup for the frontend, and it must not start
 * collecting component tests by accident.
 *
 * What belongs here: pure `.mjs` modules that `next.config.mjs` consumes, where a
 * mistake is a security exposure rather than a rendering bug. The feed proxy
 * allowlist is the first of those — it is the only thing standing between an
 * unauthenticated bridge and the public internet, so it gets asserted rather
 * than eyeballed.
 *
 * `vitest` itself is not a dependency of apps/web: it is hoisted to the
 * workspace root by npm workspaces (declared by services/api), which is why
 * `npm test -w @tradew/web` works without adding a second copy.
 */
export default defineConfig({
  test: {
    include: ['feed-proxy-routes.spec.mjs'],
    environment: 'node',
    testTimeout: 5_000,
  },
});
