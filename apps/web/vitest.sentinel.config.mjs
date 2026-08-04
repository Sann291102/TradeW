import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Pure-logic unit tests for the Sentinel workspace's framework-free helpers
 * (e.g. option-chain strike selection and formatting).
 *
 * Deliberately SEPARATE from vitest.config.mjs: that config is scoped to
 * build-time security assertions and must not start collecting feature tests
 * by accident (see its header). This config collects only the Sentinel helper
 * `*.test.ts` modules, runs them in a node environment (they touch no DOM),
 * and resolves the `@/` path alias so imports match the app.
 *
 *   npm run test:sentinel -w @tradew/web
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/lib/sentinel/**/*.test.ts', 'src/lib/strategy-workspace/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
  },
});
