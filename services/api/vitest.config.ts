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
      // Encryption at rest. What reaches Prisma is ciphertext; a missing keyring
      // refuses the write instead of storing plaintext; and no DTO or query
      // carries the credential. The column was plaintext until 2026-08-20, so
      // every assertion here is a regression guard on a real exposure.
      'src/broker/credential-storage.spec.ts',
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
      //  · open-positions — the count a limit and its own display must agree
      //    on. Two implementations of it drifted apart, and the disagreement
      //    was invisible in both: each was self-consistent, and only the
      //    console showed the account's number against the profile's limit.
      'src/paper-execution/execution-identity.spec.ts',
      'src/paper-execution/execution-policy.spec.ts',
      'src/paper-execution/execution-open-positions.spec.ts',
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
      // Fundamental research: the vendor normalizer, the ratio engine and the
      // balance-sheet check. Every failure mode in this pipeline is a CONFIDENT
      // WRONG NUMBER on a research page — a vendor null coerced to zero, a
      // ratio computed against a missing operand, a balance sheet quietly
      // "fixed" so it always reconciles, a derived figure presented as
      // reported. The old /research page shipped exactly those, hardcoded, so
      // the replacement's arithmetic is asserted rather than eyeballed.
      'src/research/research-pipeline.spec.ts',
      // The regression gate: the specific fabricated values the old page
      // rendered must never reappear in the research render path.
      'src/research/no-fabricated-values.spec.ts',
      // Telemetry attribution: an operator principal must never be written
      // into a column that foreign-keys to `User`. A `createMany` batch throws
      // as a whole, so this one mistake discarded unrelated rows too.
      'src/telemetry/telemetry-attribution.spec.ts',
      // The system graph. Every case here is a WRONG-BUT-PLAUSIBLE failure: a
      // guarded route drawn as public on a screen a security review reads, a
      // refuting relation flattened into an ordinary link, a hub that vanishes
      // at the zoom level where it matters, a filter that blanks the page
      // instead of degrading. Route discovery is asserted against a real Nest
      // testing container, so it proves what the framework would actually
      // serve rather than what a regex over the source suggests.
      'src/graph/graph.projection.spec.ts',
      // Sentinel events becoming durable notifications: the receiving end of the
      // no-direction boundary, durable dedupe, and never failing an observation.
      'src/sentinel/sentinel-event-dispatcher.spec.ts',
      // The sentinel-py ingress allowlist: the alert tier the notification bell
      // styles from must cross into the row, and nothing unreviewed may.
      'src/sentinel/sentinel-py-notify.spec.ts',
      // ---- Autonomous paper agents (2026-08-30) --------------------------
      //  · risk — the three percentages and their three DIFFERENT bases, plus
      //    the invariant the whole capital model rests on: realised risk never
      //    exceeds the budget. Swept over the input space rather than sampled,
      //    because an arithmetic bug hides in the cases nobody picks.
      'src/paper-execution/execution-risk.spec.ts',
      //  · fill — a paper fill's stated provenance, and the detection of the
      //    SYNTHETIC bid/ask the price service fabricates when a tick carries
      //    no depth. A P&L computed against an invented 10bp spread is
      //    systematically optimistic, and a journal that cannot say which it
      //    got reads as more accurate than it is.
      'src/paper-execution/execution-fill.spec.ts',
      //  · freshness — "the feed is reachable" is not "the feed is alive". The
      //    2026-08-17 incident is the whole reason this exists: the bridge
      //    answered every request in ~30 ms while serving a tick map that had
      //    stopped advancing. Unknown age FAILS.
      'src/paper-execution/execution-freshness.spec.ts',
      //  · position decisions — the ONE authoritative exit decision per
      //    observation, its precedence order, and the trailing ratchet that
      //    may never loosen.
      'src/paper-execution/position-decision.spec.ts',
      //  · calibration — bounded learning. A completed trade may move ONE
      //    number, in ONE direction past a hard floor, and the 70% platform
      //    bar is unreachable from it by construction.
      'src/paper-execution/execution-calibration.spec.ts',
      //  · the lifecycle end to end, against a real Postgres when one is
      //    configured — entry through stop/target/trail/invalidation to a
      //    journal and a calibration the NEXT decision consumes.
      'src/paper-execution/paper-lifecycle.spec.ts',
    ],
    environment: 'node',
    // The suite is deterministic and clock-injected; a slow test means a real
    // hang, not a busy machine.
    testTimeout: 5_000,
  },
});
