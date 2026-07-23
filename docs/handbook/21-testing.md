# Chapter 21 — Testing

**Status: 🔴.** There is no meaningful automated test coverage anywhere in the repository. This is the single largest engineering risk in the platform, and this chapter is therefore a remediation plan rather than a description of practice.

---

## 21.1 The honest starting position

```
   Unit tests           0
   Integration tests    0
   E2E tests            0
   Load tests           0
   Security tests       0
   ⚖️ Compliance tests  0

   Test runner          not configured
   Coverage tooling     not configured
   CI test step         does not exist
```

`.github/workflows/deploy.yml` builds images and deploys. It is a **deploy pipeline, not a CI pipeline.**

### 21.1.1 Why this happened, and why it must stop

The codebase was assembled from four inherited projects under delivery pressure, with a document-driven architecture practice that (correctly) prioritised getting the boundaries right. Tests were the thing that got deferred.

That was survivable while nothing was deployed and no user had money — even paper money — at stake. It stops being survivable at the first deployment, for a specific reason:

> **This system computes numbers about money.** `applyFill`'s close-and-flip arithmetic, the margin model, the IST session boundaries, the composite gate. A silent regression in any of them produces *plausible wrong numbers* — the worst possible failure mode, because nothing errors and nobody notices until a user does.

### 21.1.2 The target

| Layer | Coverage target | Rationale |
|---|---|---|
| Pure functions (money, indicators, signals, parsers) | **95%** | cheap, and the highest-consequence code |
| Services with I/O | 70% | |
| Controllers | smoke only | thin by design |
| React components | 50% | behaviour, not snapshots |
| Overall statements | **70%** (NFR-M1) | |

---

## 21.2 The pyramid, weighted for this system

```
                     ╱╲
                    ╱E2E╲             ~15 tests
                   ╱ ─── ╲            the MVP loop only
                  ╱       ╲
                 ╱INTEGRATION╲        ~60 tests
                ╱  ────────── ╲       API + DB, real Postgres
               ╱               ╲
              ╱   COMPONENT     ╲     ~40 tests
             ╱     ─────────     ╲    behaviour, not snapshots
            ╱                     ╲
           ╱        UNIT           ╲  ~300 tests
          ╱   ─────────────────     ╲ pure functions FIRST
         ╱_________________________  ╲

        ┌──────────────────────────────┐
        │ ⚖️ COMPLIANCE  (cross-cutting)│  runs at every layer
        │ never directive language      │  hard gate, 100%
        └──────────────────────────────┘
```

**⚖️ Compliance testing is not a layer — it is a cross-cutting gate.** It runs against pure composers in unit tests, against real responses in integration tests, and against rendered copy in E2E. It is the only suite that must be 100% green to ship.

---

## 21.3 Toolchain 🔵

| Concern | Choice | Why |
|---|---|---|
| Runner | **Vitest** | ESM-native, fast, Jest-compatible API. The `ts-node` ESM/CJS pain (TD-1) is an argument against Jest here. |
| Assertions | Vitest built-in | |
| React | Testing Library | behaviour over implementation |
| API integration | Supertest + `@nestjs/testing` | |
| Test database | Testcontainers, `pgvector/pgvector:pg16` | real Postgres, real pgvector, disposable |
| E2E | Playwright | multi-browser, trace viewer, network interception |
| Load | k6 | scriptable, CI-friendly |
| Coverage | `@vitest/coverage-v8` | |

> ⚠️ **The test database must be `pgvector/pgvector:pg16`**, not plain `postgres:16`. Migrations fail without the extension — the same trap as local development (Chapter 14 §14.10.2).

---

## 21.4 Unit tests — where to start

**Build order matters.** These are ranked by (consequence of a bug) ÷ (cost to test), and the top of the list is both the most valuable and the easiest.

### 21.4.1 ⭐ Tier 1 — `applyFill` (Chapter 11 §11.7)

A pure function. Every branch, every sign, every boundary. Perhaps sixty lines of test protecting the arithmetic underneath every number in the product.

```ts
describe('applyFill', () => {
  it('opens from flat', () =>
    expect(applyFill(0, 0, 'BUY', 100, 500))
      .toEqual({ newQuantity: 100, newAvgPrice: 500, realizedPnlDelta: 0 }));

  it('adds to a long, weighting the average', () =>
    expect(applyFill(100, 500, 'BUY', 50, 520))
      .toEqual({ newQuantity: 150, newAvgPrice: 506.666…, realizedPnlDelta: 0 }));

  it('partially closes a long and KEEPS the cost basis', () =>       // ⭐
    expect(applyFill(100, 500, 'SELL', 40, 520))
      .toEqual({ newQuantity: 60, newAvgPrice: 500, realizedPnlDelta: 800 }));

  it('fully closes a long', () =>
    expect(applyFill(100, 500, 'SELL', 100, 520))
      .toMatchObject({ newQuantity: 0, realizedPnlDelta: 2000 }));

  it('flips long → short with a split realized P&L and a new basis', () =>  // ⭐
    expect(applyFill(100, 500, 'SELL', 150, 520))
      .toEqual({ newQuantity: -50, newAvgPrice: 520, realizedPnlDelta: 2000 }));

  it('flips short → long', () => { /* … */ });
  it('closes a short at a lower price for a PROFIT', () => { /* sign handling */ });
  it('adds to a short', () => { /* … */ });
});
```

The two ⭐ cases are the ones a demo engine gets wrong: **the average price must not change on a partial close**, and **a flip must split the fill into a closing half and an opening half.**

### 21.4.2 ⭐ Tier 2 — the composite gate

The two tests the product depends on:

```ts
it('does NOT surface a single triggered signal', () => {
  // one signal, weight 0.35
  expect(result.synthesis).toBeNull();
  expect(result.observations).toHaveLength(1);   // ← still audited
});

it('surfaces when two signals clear 0.7', () => {
  // 0.40 + 0.35 = 0.75
  expect(result.synthesis).not.toBeNull();
  expect(result.synthesis.confidence).toBeCloseTo(0.675);   // min(0.95, 0.75/2 + 0.3)
});

it('does not surface two trivial signals below the weight threshold', () => {
  // 0.10 + 0.15 = 0.25 — count passes, weight does not
  expect(result.synthesis).toBeNull();
});
```

> **If the first test ever fails, the product has become a noisy alert system and the thesis is broken.** It is the highest-value test in the repository.

### 21.4.3 Tier 3 — behavioural signals

`EmotionIntelligenceService.signals(trades)` is a pure function over an array. No database, no mocks, no fixtures beyond literals.

```ts
it('does not trigger revenge_trading on ONE quick re-entry', () => { /* threshold is 2 */ });
it('triggers on two', () => { /* … */ });
it('excludes gaps over 15 minutes', () => { /* … */ });
it('ignores negative gaps from out-of-order timestamps', () => { /* the gapMin >= 0 guard */ });
it('does not break a loss streak on a position-OPENING trade', () => {
  // realizedPnl undefined must neither extend nor reset the streak
});
it('measures position sizing against the user’s OWN average', () => { /* not an absolute */ });
it('uses the MEDIAN gap, not the mean, for impatient_pacing', () => { /* one lunch break */ });
```

This produces the most sensitive output in the platform — a claim about a specific person's behaviour with their own money. Untested is not an acceptable state for it.

### 21.4.4 Tier 4 — IST boundaries ⭐

The highest bug-density area in the codebase.

```ts
it('rolls session end forward when placed after 15:30 IST', () => { /* … */ });
it('rolls forward over a weekend', () => { /* Friday 16:00 → Monday 15:30 */ });
it('NEVER returns an already-past expiry', () => { /* ← the Friday-16:00 bug */ });
it('gives a stable IST day key across a UTC midnight', () => { /* … */ });

// run the whole file under several process timezones
describe.each(['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London'])(
  'IST utilities under TZ=%s', (tz) => { /* … */ });
```

**Running under a non-IST `TZ` is the point.** A test that only passes on an IST machine tests nothing.

### 21.4.5 Tier 5 — the binary parser

Pure, synchronous, and deliberately built to be testable without a live connection (Chapter 12 §12.9.1).

```ts
it('reads a little-endian header',                        …);
it('parses Ticker (16 bytes)',                            …);
it('parses Quote with OHLC and volume',                   …);
it('parses Full with 5 depth levels and OI',              …);
it('returns kind=unknown for an unrecognised feed code',  …);
it('leaves absent fields UNDEFINED, not zero',            …);   // ⭐
it('does not throw on a truncated buffer',                …);   // ⭐ partial TCP read
```

### 21.4.6 Tier 6 — margin, indicators, entitlements, context

```
   computeMargin       one test per branch (option BUY, CNC, option SELL,
                       FUTURE, MIS) + the rejection path
   indicators          against known reference series; null below the period
   EntitlementsService one test per `reason` value — nine of them
   SimpleContextManager  ⭐ guardrails are NEVER trimmed, even at a
                          tiny budget with a huge history
```

That last one is a compliance control expressed as a unit test (Chapter 18 §18.6.2).

---

## 21.5 Integration tests

Real Postgres via Testcontainers. Real HTTP through Supertest. No mocked database.

### 21.5.1 Setup

```ts
beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  execSync('prisma migrate deploy --schema packages/database/prisma/schema.prisma');
  app = await createTestApp();
});
beforeEach(() => truncateAllTables());     // isolation between tests
afterAll(() => container.stop());
```

> **Truncate between tests, not between files.** Shared state between tests in one file is the most common source of a suite that passes locally and fails in CI under a different execution order.

### 21.5.2 The order lifecycle suite

```ts
it('places a MARKET order and fills it in one transaction',            …);
it('rejects on lot-size violation without creating an Order row',      …);
it('REJECTS on insufficient margin AND records the row with a reason', …);  // ⭐
it('rests a LIMIT as OPEN and blocks margin',                          …);
it('rests SL as TRIGGER_PENDING, moves to OPEN on trigger',            …);
it('fills SL and its limit in the SAME tick when one move satisfies both', …);  // ⭐
it('never fills worse than the limit price',                           …);
it('cancels and releases EXACTLY the blocked margin',                  …);
it('EXPIREs a DAY order past session close and releases margin',       …);
it('keeps a flattened position row as history',                        …);
```

Two ⭐ cases: the rejection **creating** a row (Chapter 11 §11.4.1 — it is a trading event, not a client bug), and the same-tick re-check (§11.6.5).

### 21.5.3 Authorization suite 🔒

```ts
it('rejects an unauthenticated request',                          …);
it('rejects a malformed bearer token',                            …);
it('rejects an expired token',                                    …);
it('IGNORES a userId in the request body and uses the token’s',   …);  // ⭐ IDOR
it('rejects a guarded route without the capability',              …);
it('returns reason and quota in the 403 body',                    …);
it('rejects /observe on Sentinel without a service token',        …);  // ARCH-1
it('rejects an unknown service token',                            …);
it('serves /health WITHOUT a service token',                      …);
```

The ⭐ test is the single most important authorization test: send `{ …, userId: '<other-user>' }` and assert the operation applied to the *token's* user.

### 21.5.4 ⭐ Architectural regression suite

These protect the four rules that cannot be broken:

```ts
// ARCH-3 — Sentinel never gates
it('places an order at unchanged latency with Sentinel unreachable', async () => {
  await stopSentinel();
  const t0 = Date.now();
  const res = await placeOrder();
  expect(res.status).toBe(201);
  expect(Date.now() - t0).toBeLessThan(BASELINE_MS * 1.2);
});

// ARCH-2 — no order-placement tool exists
it('exposes no order-placement tool in the registry', () => {
  const names = toolRegistry.list().map(t => t.name);
  expect(names).not.toContain('place_order');
  expect(names.some(n => /order|trade|buy|sell|position/i.test(n) && !/^get_/.test(n)))
    .toBe(false);
});

// ARCH-1 — one ingress
it('has no HTTP client for services/trading-engine in services/sentinel', () => { /* static check */ });
```

---

## 21.6 ⚖️ Compliance testing

**The one suite that is a hard gate.** 100% required to ship.

### 21.6.1 The forbidden-language suite

```ts
const FORBIDDEN = [
  /\b(buy|sell|short|long)\s+(now|here|this|at)\b/i,
  /\btarget\s+(price|of)?\s*[₹\d]/i,
  /\bstop.?loss\s+(at|of)\s*[₹\d]/i,
  /\bdon'?t\s+(buy|sell|trade)\b/i,
  /\b\d{1,3}%\s+(probability|chance)\s+of\s+profit\b/i,
  /\byou should\b/i,
  /\b(reduce|increase) your (size|position|risk)\b/i,
  /\btake a break\b/i,
  /\bstep away\b/i,
  /you (seem|appear|are)\s+(to be )?(feeling|experiencing)/i,   // no diagnosis
];

it('never produces forbidden language across the generated corpus', () => {
  for (const scenario of SCENARIOS) {                 // ≥500
    const text = composeDeterministic(scenario);
    for (const p of FORBIDDEN) expect(text).not.toMatch(p);
  }
});
```

### 21.6.2 Two execution modes

| Mode | Target | Cadence | Cost |
|---|---|---|---|
| **Deterministic** | the template composer | every CI run | free, exhaustive |
| **Live model** | a real provider | nightly | metered — catches guardrail drift after a prompt or model change |

The nightly live run is what catches the case where a prompt edit or a model upgrade quietly weakens adherence. The deterministic run is what makes the gate cheap enough to run on every PR.

### 21.6.3 The other compliance assertions

```ts
it('attaches a disclaimer to EVERY synthesis',                       …);
it('persists evidence with every observation',                       …);
it('assigns a SEBI category to every observation',                   …);
it('caps synthesis confidence at 0.95',                              …);
it('withholds statistics below MIN_SAMPLE (5)',                      …);
it('reports an unavailable Market Context dimension as unavailable', …);  // ⭐ never fabricated
it('shows a NEUTRAL signal-source label, never an agent name',       …);  // ⭐
```

---

## 21.7 Component tests

Testing Library. **Behaviour, not snapshots.**

> Snapshot tests on a UI that changes weekly produce a ritual of pressing `-u` without reading the diff. That is worse than no test, because it manufactures confidence.

```ts
it('shows a locked state with an upgrade CTA when unentitled',      …);  // ⭐ visibility rule
it('renders the Sentinel nav item for an UNENTITLED user',          …);  // ⭐ never hidden
it('expands a Why panel showing evidence and confidence',           …);
it('opens the command palette on ⌘K and closes on Escape',          …);
it('restores layout after rehydration without a mismatch warning',  …);
it('shows a preview badge when candle status is "preview"',         …);  // ⭐ honesty
it('renders a stale position row rather than dropping it',          …);  // ⭐
```

Five of these seven are testing an *honesty* property rather than a mechanical one. That is the right emphasis for this product.

---

## 21.8 E2E tests

Playwright. **~15 tests, covering the MVP loop and nothing else.**

E2E tests are slow, flaky, and expensive to maintain. Their job is to prove the seams hold, not to test logic that unit tests already cover.

### 21.8.1 The MVP loop (Chapter 3 §3.11.1)

```
   signup → onboarding → paper order at a real price →
   corroborated observation → "Why" panel → journal entry →
   linked lesson → return to a restored workspace
```

```ts
test('a new user completes the full learning loop', async ({ page }) => { /* … */ });
test('workspace layout survives a reload',          async ({ page }) => { /* … */ });
test('an unentitled user sees Sentinel locked, not hidden', async ({ page }) => { /* … */ });
test('order rejection surfaces a readable reason',  async ({ page }) => { /* … */ });
test('the chart axis renders in IST under a non-IST browser timezone',
  async ({ browser }) => {
    const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
    /* assert 09:15 */
  });
```

That last one is worth an E2E test specifically because it can only fail in a real browser with a real timezone.

### 21.8.2 E2E discipline

```
   □ Test flows, never units
   □ Data-testid selectors, never CSS classes or text that copy edits will change
   □ Seeded, deterministic fixtures — never live market data
   □ No sleeps; wait on conditions
   □ A flaky E2E test is DELETED or FIXED the same week.
     Quarantining it teaches the team to ignore red.
```

---

## 21.9 Load and stress testing 🔵

k6. Four scenarios, each producing a number that replaces a guess in Chapter 20 §20.2.

```js
export const options = {
  scenarios: {
    dashboard:      { vus: 100, duration: '5m' },
    orders:         { vus: 50,  duration: '5m' },
    matching_depth: { /* 500 resting orders, observe tick duration */ },
    observe:        { vus: 200, duration: '5m' },
  },
  thresholds: {
    'http_req_duration{scenario:dashboard}': ['p(95)<200'],
    'http_req_duration{scenario:orders}':    ['p(95)<500'],
    'http_req_duration{scenario:observe}':   ['p(95)<300'],
    http_req_failed: ['rate<0.001'],
  },
};
```

### 21.9.1 The stress questions

Each has a number as its answer, and we currently know none of them:

```
   · At how many resting orders does a matching tick exceed 3 seconds?
     (When it does, ticks overlap and the whole model breaks.)
   · At how many concurrent /observe calls does p95 exceed 300 ms?
   · At how many MemoryRecord rows does unindexed vector search
     become the slowest query?                      ← PERF-2 in numbers
   · How many connections does the API hold per replica, and at how
     many replicas does Postgres run out?
   · What happens when the Dhan bridge returns 500 for 60 seconds?
```

### 21.9.2 The failure-mode tests

```ts
it('degrades cleanly when the bridge is down',            …);   // clear error, no crash
it('degrades cleanly when the LLM provider is down',      …);   // deterministic composition
it('degrades cleanly when the Brain is unreachable',      …);   // observation still returned
it('does not double-fill when two matching ticks overlap',…);   // ⭐ OPS-1
```

---

## 21.10 Chaos engineering 🔵

Not a priority until the platform is deployed and stable, but the experiments are worth writing down now because the system was *designed* for them (Principle 8).

| Experiment | Expected | Blast radius |
|---|---|---|
| Kill `services/sentinel` | orders place at unchanged latency; panel degrades | 1 panel |
| Kill the live-feed bridge | order placement returns a clear error; charts fall back to preview | prices |
| Kill Postgres | API 500s; frontend shows a degraded state | total |
| Add 500 ms latency to the bridge | matching ticks slow; no double-fill | fills delayed |
| Remove every AI provider key | deterministic composition everywhere | none |
| Fill the disk | writes fail; reads continue | writes |
| Kill one API replica mid-transaction | Prisma rolls back; no partial state | that request |

**The first row is the hypothesis the whole architecture rests on** (ARCH-3), and it should be run first, deliberately, in staging, before anyone claims it is true.

---

## 21.11 CI integration 🔵

### 21.11.1 The pipeline that should exist

```yaml
on: [pull_request, push]

jobs:
  quality:
    - typecheck                                    # blocking
    - lint (once ESLint exists — TD-3)             # blocking
    - unit tests + coverage                        # blocking, ≥70%
    - ⚖️ compliance suite (deterministic)          # blocking, 100%

  integration:
    services: pgvector/pgvector:pg16
    - migrate deploy
    - integration tests                            # blocking

  e2e:
    - build, seed, playwright                      # blocking on main

  security:
    - npm audit --audit-level=high                 # blocking
    - gitleaks                                     # blocking

  performance:
    - size-limit (bundle budget)                   # blocking
    - lighthouse-ci (dashboard LCP)                # warning first, then blocking
    - benchmark suite (>20% regression)            # warning

  nightly:
    - ⚖️ compliance suite against a LIVE model
    - k6 load scenarios
    - full dependency scan
```

### 21.11.2 What blocks a merge

```
   BLOCK      typecheck · lint · unit · ⚖️ compliance · integration ·
              npm audit high+ · gitleaks · bundle budget
   WARN       coverage delta · lighthouse · benchmarks
   NIGHTLY    live-model compliance · load · full SCA
```

**⚖️ Compliance blocks at 100%.** Everything else has a threshold; that one has a requirement.

---

## 21.12 The remediation roadmap

Ordered by (risk reduced) ÷ (effort). Realistic: about four engineer-weeks to a defensible position.

### Week 1 — infrastructure and the money maths

```
   □ Vitest configured at the root, per-workspace projects
   □ Coverage reporting
   □ CI job running unit tests
   □ ⭐ applyFill — 10 tests
   □ ⭐ computeMargin — 6 tests
   □ ⭐ IST utilities — 8 tests, under 4 timezones
```

End of week 1: **the arithmetic underneath every number in the product is protected.**

### Week 2 — Sentinel and compliance

```
   □ ⭐ composite gate — 4 tests
   □ EmotionIntelligenceService — 12 tests
   □ TrapIntelligenceService — 10 tests
   □ ⚖️ forbidden-language suite (deterministic) — blocking in CI
   □ SimpleContextManager guardrail-preservation test
```

End of week 2: **the product thesis and the compliance posture are both regression-protected.**

### Week 3 — integration

```
   □ Testcontainers harness
   □ Order lifecycle — 10 tests
   □ Authorization — 9 tests, including the IDOR case
   □ ⭐ architectural regression — 3 tests (ARCH-1, -2, -3)
   □ Entitlement decisions — one per reason
```

End of week 3: **the seams are covered and the four rules are enforced by the build.**

### Week 4 — E2E, components, load

```
   □ Playwright + the MVP-loop test
   □ ~6 more E2E flows
   □ ~15 component tests (locked state, Why panel, palette, preview badge)
   □ k6 scenarios → record the real numbers into Chapter 20 §20.2
```

End of week 4: **~70% coverage, all four architectural rules enforced, ⚖️ compliance gated, and the performance targets replaced by measurements.**

---

## 21.13 Testing standards

```
   □ Test names state BEHAVIOUR, not implementation
        ✅ 'keeps the cost basis on a partial close'
        ❌ 'applyFill case 2'
   □ One assertion concept per test
   □ Arrange–Act–Assert, visually separated
   □ No mocking of what you own — use the real Postgres
   □ Mock only external boundaries (Dhan, LLM providers)
   □ Deterministic: no Date.now(), no Math.random(), no live market data
   □ Fast: unit suite under 10 seconds total
   □ Independent: any test runnable alone, in any order
   □ ⚖️ A bug fix ships with the test that would have caught it
   □ A flaky test is fixed or deleted the same week — never quarantined
```

### 21.13.1 The bug-fix rule

> **Every bug fix ships with a regression test.** No exceptions.

The IST rollforward bug (an order placed Friday 16:00 expiring within three seconds) is exactly the kind of defect that returns during a refactor. The comment in `ist-time.util.ts` explains it; a test would *enforce* it.

---

## 21.14 Testing debt summary

| ID | Item | Severity |
|---|---|---|
| **TEST-1** | **No tests at all** | **critical** |
| TEST-2 | No test runner configured | critical |
| TEST-3 | No CI test step | critical |
| TEST-4 | ⚖️ No compliance-language gate | critical |
| TEST-5 | No coverage measurement | high |
| TEST-6 | No integration harness | high |
| TEST-7 | No E2E | medium |
| TEST-8 | No load testing (PERF-8) | medium |
| TEST-9 | No chaos experiments | low |

**TEST-1 is the largest single engineering risk in the platform**, and unlike most items in this handbook it has no partial mitigation: there is no compensating control, no manual process, and no reviewer discipline that substitutes for a test suite on arithmetic that produces money-shaped numbers.

---

*Next: [Chapter 22 — DevOps](22-devops.md)*
