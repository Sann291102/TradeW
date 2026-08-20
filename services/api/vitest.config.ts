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
      // Backtesting. The money suite pins the identity that makes a result
      // trustworthy — gross - fees - slippage = net, on every trade — plus the
      // pessimistic fill rules (stop before target within a bar, a gap fills at
      // the open) and the risk gates. The metrics suite pins the other half:
      // which numbers are suppressed for insufficient sample rather than
      // printed as if they meant something.
      // Agent Trading Laboratory, Phase 0. Pins the three properties whose
      // absence is silent: an idempotency key that is not idempotent, a health
      // gate that cannot tell "switched off" from "waiting", and an
      // availability record that calls a closed market a degraded feed. Also
      // asserts the no-fake-dashboard rule structurally - an event kind whose
      // machinery does not exist yet cannot be emitted.
      'src/lab/lab-phase0.spec.ts',
      'src/backtest/execution-simulator.spec.ts',
      'src/backtest/backtest-metrics.spec.ts',
      'src/backtest/backtest-config.spec.ts',
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
      // The NSE dataset allowlist: the only thing between a caller-supplied
      // string and an outbound request from inside this network. Nothing
      // outside the catalogue resolves, no entry leaves nseindia.com, and the
      // one interpolated path segment cannot be other than eight digits.
      'src/nse/nse-datasets.spec.ts',
      // The participant-OI CSV reader. Every failure mode is a confident
      // number attributed to the wrong participant or the wrong column, and
      // the real file's padded headers make an untrimmed lookup miss silently.
      'src/nse/nse.service.spec.ts',
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
      // Sentinel paper execution. Two pure modules, both load-bearing:
      //
      //  · identity — the idempotency guarantee. One Sentinel decision must
      //    never open two paper positions because a poll repeated or a replica
      //    raced, and the key deliberately EXCLUDES the Sentinel run id (a
      //    fresh uuid per call would mint a new key every tick).
      //  · policy   — the risk gate, including the PAPER-only refusal that
      //    holds even against a row this application did not write.
      'src/paper-execution/execution-identity.spec.ts',
      'src/paper-execution/execution-policy.spec.ts',
      //  · account   — WHOSE account an agent may trade. Pins the two bypasses
      //    that would let an agent trade a real person's money without consent:
      //    labelling a real account SYSTEM_PAPER to skip the consent check, and
      //    marking it USER_PAPER without ever asking.
      'src/paper-execution/execution-account.spec.ts',
      // Who is allowed to use a paid capability, and until when.
      // Active pricing served to every surface. Asserts across the API boundary
      // that no route can produce a withdrawn annual Sentinel term.
      'src/pricing/pricing.spec.ts',
      'src/entitlements/entitlements.spec.ts',
      // Redemption must create a real subscription. It used to happen entirely
      // in the browser, so the UI unlocked and every premium call still 403'd.
      'src/entitlements/coupon-redeem.spec.ts',
      // The paid 7-day trial: derived (never hand-typed) pricing, a claim that
      // is durable rather than "is there a live subscription", and a day-length
      // grant that must not quietly become a month.
      'src/payments/trial.spec.ts',
      // Bearer-token parsing: the gate in front of every authenticated route.
      'src/auth/auth.guard.spec.ts',
      // When an OTP may appear in its own HTTP response. The rule was "only
      // when the channel is unconfigured" but the test was `!delivered`, which
      // is also true of a configured provider that failed — so any provider
      // outage turned POST /auth/otp/request into an OTP oracle for any
      // address. Pinned in both directions, for mail and SMS.
      'src/auth/otp-disclosure.spec.ts',
      // Mail provider selection, and the `preview`-only-in-console-mode
      // invariant the disclosure rule above is built on.
      'src/mail/mail.service.spec.ts',
      // Boot-time secret policy: no dev-fallback / vendor-key auth secrets
      // (2026-08-10 assessment — JWT_SECRET forgery + ADMIN_API_TOKEN reuse).
      'src/common/secret-validation.spec.ts',
      // AdminTokenGuard fails closed on a weak/vendor operator secret.
      'src/auth/admin-token-guard.spec.ts',
      // The two-door admin gate: the operator door never weakens the product-
      // admin door, and the operator token is required-but-never-sufficient.
      'src/admin/admin-access.guard.spec.ts',
      // Operator identity: assertion signed with its OWN key (not JWT_SECRET),
      // revocation as a per-request store read, and login lockout.
      'src/admin/operator/operator.service.spec.ts',
      // Rate limiting: the global bucket really is global, and probes are exempt.
      'src/common/throttling.spec.ts',
      // Background timers run on exactly one instance (the horizontal-scaling gate).
      'src/common/leader-election.spec.ts',
      // Sentinel events becoming durable notifications: the receiving end of the
      // no-direction boundary, durable dedupe, and never failing an observation.
      'src/sentinel/sentinel-event-dispatcher.spec.ts',
      // The sentinel-py ingress allowlist: the alert tier the notification bell
      // styles from must cross into the row, and nothing unreviewed may.
      'src/sentinel/sentinel-py-notify.spec.ts',
    ],
    environment: 'node',
    // The suite is deterministic and clock-injected; a slow test means a real
    // hang, not a busy machine.
    testTimeout: 5_000,
  },
});
