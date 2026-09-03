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
      // The footer link registry. Same rule as the line above: a mistake here
      // is an exposure, not a rendering bug. It fails the build on an external
      // URL nobody verified (the audit found a plausible-looking Instagram
      // handle that belongs to a DIFFERENT financial company), on a footer link
      // into the auth wall, on a legal page that is not publicly reachable, and
      // on a landing anchor that no section declares any more.
      'src/lib/footer/links.test.ts',
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
      // Institutional data. Two boundaries in one file: a judgement question
      // that names FIIs must not be answered with a flow number, and the
      // action the agent emits carries an ASK and never a destination — the
      // reason "the agent can reach NSE" is not "the agent can make this
      // server fetch anything".
      'src/lib/assistant/flows.test.ts',
      // Per-tab session isolation. Regression cover for "every tab shows
      // whoever logged in last" — the credential's storage scope is the fix,
      // so it is asserted rather than eyeballed.
      'src/lib/session-storage.test.ts',
      // The routing cookie's two repair directions. The missing one let a
      // `tw_auth` that outlived its token admit a signed-out browser to the
      // workspace for the cookie's full 30 days — reported as "localhost skips
      // the landing page but the tunnel URL doesn't", because a cookie jar is
      // per-origin and the split therefore looks environmental.
      'src/lib/auth-hint.test.ts',
      // The forming candle. Regression cover for a chart whose last-price line
      // sat at yesterday's close while the card beside it showed today's price.
      'src/lib/hooks/liveCandle.test.ts',
      // The strategy-contract leak test. Renders two unrelated strategies
      // through the same components and fails if any of them names a template
      // id — the guard that keeps P7 from becoming ten dashboards.
      'src/components/sentinel/genericStrategyRendering.test.tsx',
      // The research render path. Every failure mode here is a number on a
      // fundamental-research page that no provider produced — an absent metric
      // rendered as 0, a half-known range shown as a range, a derived figure
      // presented as reported, a balance sheet whose discrepancy is hidden.
      // The page this replaced shipped exactly that class of defect as
      // constants, which is why the assertions lead with the absent cases.
      'src/components/research/**/*.test.tsx',
      // Chart drawing geometry. Every failure mode here paints a *plausible*
      // annotation stating a price level that was never detected, so the
      // placement rules are asserted rather than eyeballed.
      'src/lib/charts/drawings.test.ts',
      // Fair value gap detection. Three-bar arithmetic with one right answer,
      // and the failure modes (a gap mitigated by the candle that created it,
      // a bearish gap tested with the bullish rule) look correct on screen.
      'src/lib/charts/fvg.test.ts',
      // Vendor symbol -> TradingView symbol for the crypto/FX venues. Squarely
      // in this file's "a mistake is an exposure, not a rendering bug" rule: a
      // wrong prefix points the embedded chart at a different exchange from the
      // one the board is quoting, and because the widget renders in a
      // cross-origin iframe there is nothing that can detect the mismatch at
      // runtime. It draws a plausible chart of the wrong market.
      'src/lib/markets/tradingViewSymbols.test.ts',
      // Chart-detection routing. Pins the collision between "mark the fair
      // value gaps" (draw) and "what is a fair value gap" (explain), which
      // reach the same matcher with the same words.
      'src/lib/assistant/detect.test.ts',
      // The engine's reading of the chart beside it. Every failure mode here
      // is a confident statement about bars: a measurement the sweep never
      // produced, or a stale one presented as current after the bridge died.
      'src/components/sentinel/SentinelChartReading.test.tsx',
      // The other engine's reading — what `/observe` read across the index and
      // both option legs. Same class of failure as the strip above, plus the
      // one this surface adds by naming a strike and a side together: it is
      // the only place in the workspace where a recommendation could be
      // implied by layout alone, so Rule 2 is asserted here.
      'src/components/sentinel/SentinelContractReading.test.tsx',
      // The strategy contract read back to the user. A card full of price
      // levels on a surface forbidden from recommending any is only safe
      // because every number on it came from the user — so the boundary is
      // asserted, including that the reference mock's position-size
      // recommendation never appears.
      'src/components/sentinel/StrategyConditionsPanel.test.tsx',
      // The one invariant the whole workspace is built on: the contract the
      // operator selected is the contract the charts draw, and the "Sentinel
      // reads this" badge appears only where the engine actually read it. Both
      // failed silently for a week when the dashboard passed literal null
      // strikes and the engine's own at-the-money pick decided what was drawn.
      'src/components/sentinel/SentinelLiveCharts.test.tsx',
      // The two strike selectors. The property under test is the one that makes
      // them a PAIR rather than one control with a side switch: a control can
      // only return a strike from the ladder it was given, so a CE box cannot
      // reach a PE contract by any path — default list, search, or typed input.
      // Asserted with deliberately ASYMMETRIC ladders, because two identical
      // ladders let every cross-side bug pass.
      'src/components/sentinel/strategy/StrikeCombobox.test.tsx',
      // The Strategy Feed's four states. It used to render NOTHING while its
      // watch list was in flight — a hole in the dashboard band, reported as
      // 'the strategy feed is missing' — and to present a FAILED watch query as
      // an empty one, telling the user to start a watch when the service could
      // not be reached.
      'src/components/sentinel/strategyFeedStates.test.tsx',
    ],
    environment: 'node',
    // The strategy components are rendered with renderToStaticMarkup, which
    // needs the automatic JSX runtime — esbuild otherwise emits React.createElement
    // calls into files that never import React.
    testTimeout: 5_000,
  },
});
