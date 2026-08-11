import { defineConfig } from 'vitest/config';

/**
 * Scoped deliberately narrow: the discipline module's pure logic, and the
 * security decisions added by the 2026-07-29 hardening pass.
 *
 * It is NOT an attempt to backfill coverage across `services/api`. The 2026-08
 * audit pass added the three highest-risk gaps it named — order fill math,
 * entitlement decisions, and bearer-token parsing — but margin computation
 * (`computeMargin`), the matching engine's polling loop, and the whole of
 * `crypto/`, `instruments/`, `knowledge/`, `market-data/`, `notification/` and
 * `sentinel/` remain uncovered and are tracked separately. The `include` below
 * is an allowlist rather than a glob over `src/**` so adding a suite is a
 * deliberate act, and so this config can never start failing CI on code it was
 * never scoped to cover.
 *
 * Everything under test is pure or dependency-injected: no database, no Nest
 * application context, no network. `vitest run` needs nothing running. The guard
 * suites construct guards directly with a stub JwtService and a structural
 * ExecutionContext for the same reason.
 */
export default defineConfig({
  test: {
    include: [
      'src/discipline/discipline-limits.spec.ts',
      'src/discipline/market-calendar.spec.ts',
      // Broker OAuth: which callback may write a credential, and whose.
      'src/broker/oauth-state.spec.ts',
      // The single-use claim: conditional update, claimed before the exchange.
      'src/broker/dhan-auth.service.spec.ts',
      // Authentication, operator authorization, and cross-user refusal.
      'src/broker/broker-authz.spec.ts',
      // Feed link validation — the XSS boundary on third-party content.
      'src/news/feed-url.spec.ts',
      // Proof that a secret cannot be logged through the security logger.
      'src/common/security-log.spec.ts',
      // Learning Platform: entitlement/admin access decisions, and progress math.
      'src/learning/learning-access.spec.ts',
      'src/learning/learning-progress.spec.ts',
      // Position averaging and realized P&L — the paper-money arithmetic.
      'src/sim/order-fill.spec.ts',
      // T+1 settlement's only arithmetic: merging a settled lot into a Holding.
      'src/sim/settlement.spec.ts',
      // Trade History's algebraic entry-price recovery, incl. the flip-fill edge case.
      'src/sim/trade-history.spec.ts',
      // Performance's percent-return arithmetic.
      'src/sim/performance.spec.ts',
      // Position Management "Convert product type" merge math.
      'src/sim/position-convert.spec.ts',
      // Who is allowed to use a paid capability, and until when.
      // Active pricing served to every surface. Asserts across the API boundary
      // that no route can produce a withdrawn annual Sentinel term.
      'src/pricing/pricing.spec.ts',
      'src/entitlements/entitlements.spec.ts',
      // Bearer-token parsing: the gate in front of every authenticated route.
      'src/auth/auth.guard.spec.ts',
      // Boot-time secret policy: no dev-fallback / vendor-key auth secrets
      // (2026-08-10 assessment — JWT_SECRET forgery + ADMIN_API_TOKEN reuse).
      'src/common/secret-validation.spec.ts',
      // AdminTokenGuard fails closed on a weak/vendor operator secret.
      'src/auth/admin-token-guard.spec.ts',
      // Rate limiting: the global bucket really is global, and probes are exempt.
      'src/common/throttling.spec.ts',
      // Background timers run on exactly one instance (the horizontal-scaling gate).
      'src/common/leader-election.spec.ts',
    ],
    environment: 'node',
    // The suite is deterministic and clock-injected; a slow test means a real
    // hang, not a busy machine.
    testTimeout: 5_000,
  },
});
