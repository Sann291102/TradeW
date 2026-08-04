import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Pure-logic unit tests for apps/admin's framework-free helpers — the session
 * signing/verification in particular, since it is the entire admin auth
 * boundary. Node environment (Web Crypto is a Node global; no DOM needed).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/lib/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
  },
});
