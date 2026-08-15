import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Tests for the web app's build-time security configuration and pure helpers.
 *
 * Scoped, like services/api's config, to an explicit allowlist rather than a glob
 * — this is not a general test setup for the frontend, and it must not start
 * collecting component tests by accident.
 *
 * What belongs here: pure `.mjs` modules that `next.config.mjs` consumes, where a
 * mistake is a security exposure rather than a rendering bug. The feed proxy
 * allowlist is the first of those — it is the only thing standing between an
 * unauthenticated bridge and the public internet, so it gets asserted rather
 * than eyeballed. Framework-free `src/**` helpers that run in a node
 * environment belong here too.
 *
 * The allowlist previously named only the feed-proxy spec, which meant
 * `npm test -w @tradew/web` silently skipped `src/lib/sentinel/optionChain.test.ts`
 * — the file existed, passed, and gated nothing, because reaching it required
 * knowing that a second script (`test:sentinel`) existed. Both are named
 * explicitly now, so the default `test` script reports on everything that
 * exists. `vitest.sentinel.config.mjs` is retained for focused runs of just the
 * Sentinel helpers and still works unchanged.
 *
 * The `@` alias is resolved here because those helpers import through it, the
 * same way the app does.
 *
 * `vitest` itself is not a dependency of apps/web: it is hoisted to the
 * workspace root by npm workspaces (declared by services/api), which is why
 * `npm test -w @tradew/web` works without adding a second copy.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: [
      // The /feed proxy allowlist — the boundary in front of an unauthenticated bridge.
      'feed-proxy-routes.spec.mjs',
      // Option-chain strike selection and formatting: pure, no DOM.
      'src/lib/sentinel/**/*.test.ts',
      // The assistant's utterance resolver. Belongs under the "a mistake here is
      // an exposure, not a rendering bug" rule above: this grammar decides
      // whether "should I buy NIFTY at this price" is answered with a number or
      // refused, and it is pure and framework-free by design (types.ts).
      'src/lib/assistant/**/*.test.ts',
      // Active pricing — a drifted price is a billing incident with a UI in
      // front of it, and the withdrawn annual term must stay withdrawn.
      'src/lib/pricing.test.ts',
      // The pre-paint session decision. Regression cover for the middleware
      // redirect loop that rendered a blank page after every server start.
      'src/lib/session-redirect.test.ts',
      // Voice selection and speech text — the parts testable without audio.
      'src/lib/assistant/voice-output.test.ts',
      // Explain-questions must never resolve to navigation.
      'src/lib/assistant/concepts.test.ts',
      // Per-tab session isolation. Regression cover for "every tab shows
      // whoever logged in last" — the credential's storage scope is the fix,
      // so it is asserted rather than eyeballed.
      'src/lib/session-storage.test.ts',
      // The forming candle. Regression cover for a chart whose last-price line
      // sat at yesterday's close while the card beside it showed today's price.
      'src/lib/hooks/liveCandle.test.ts',
      // The strategy-contract leak test. Renders two unrelated strategies
      // through the same components and fails if any of them names a template
      // id — the guard that keeps P7 from becoming ten dashboards.
      'src/components/sentinel/genericStrategyRendering.test.tsx',
    ],
    environment: 'node',
    // The strategy components are rendered with renderToStaticMarkup, which
    // needs the automatic JSX runtime — esbuild otherwise emits React.createElement
    // calls into files that never import React.
    testTimeout: 5_000,
  },
});
