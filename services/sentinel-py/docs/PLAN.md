# Sentinel (Python) — Plan and Status

**Last verified against the code:** 2026-08-15 · `main` @ `43906e6`
**Test suites:** 254 pytest (21 files) · 334 web tests

This is the honest ledger. Anything marked **Done** has code and tests on
`main`. Anything marked **Not started** has neither, however thoroughly it is
described elsewhere.

---

## 1. Phase status

| Phase | Scope | Status |
|---|---|---|
| **P0** | FastAPI scaffold, `/health`, service-token guard, compose + dev script + env wiring | ✅ Done |
| **P1** | Deterministic text parser + strategy CRUD, `UserStrategy` table | ✅ Done |
| **P2** | Watch engine: candle fetcher, evaluator, `IDLE→FORMING→CONFIRMED`, leased sweep loop | ✅ Done |
| **P3** | Notification dispatch → `services/api` → `Notification` row, behind the compliance gate | ✅ Done |
| **P4** | In-trade monitoring: R milestones, invalidation, projected level, structure break | ✅ Done |
| **P5** | Image/video strategy extraction | ⬜ Not started |
| **P6** | Admin portal surfaces | ⬜ Not started |
| **P7** | Strategy workspace UI: adopt → configure → watch → focus → feed → performance | ✅ Done |
| **P8** | News Research / Market Impact pipeline | ⬜ Not started — deliberately |

### Beyond the original phases

| Work | Status |
|---|---|
| Rejection events (a met condition given back) | ✅ Done |
| Performance funnel + R stats | ✅ Done |
| Strategy template catalogue + adopt flow | ✅ Done — **10 of 11 adoptable** |
| Generic strategy contract + typed frontend adapter | ✅ Done |
| Strategy-specific analytics segments | ✅ Built, **0 real samples** |
| Parser correctness rewrite | ✅ Done (PR #13) |
| Python CI job + Docker image build | ✅ Done |
| WebSocket push | ⬜ Deferred, issue #7 |

---

## 2. Strategy catalogue: 10 of 11

| Strategy | Primitives | Status |
|---|---|---|
| 15-Minute Opening Range Breakout + Retest | opening_range, close_beyond_level, retest, relative_volume | ✅ |
| 30-Minute Opening Range Breakout | same, no retest | ✅ |
| EMA-7 Bullish Reclaim | ema, ema_slope, candle_body_vs_level, reclaim | ✅ long only |
| 9/21 EMA Pullback | ema, ema_slope, pullback_depth | ✅ |
| VWAP Bounce / Rejection | vwap, vwap_slope, vwap_test_count | ✅ |
| End-of-Day VWAP Mean Reversion | vwap, atr, session_clock | ✅ |
| Support / Resistance Flip | level_detection, level_age | ✅ |
| Flag / Pennant Continuation | impulse_detection, volatility_contraction | ✅ |
| Supply / Demand Zone | zone_detection, zone_scoring, htf_alignment | ✅ |
| Liquidity Sweep + Fair Value Gap | liquidity_pools, displacement, fair_value_gap, structure_shift | ✅ |
| **News Momentum** | news_feed, news_classification, reaction_persistence | ⛔ **Unavailable — requires News Research / Market Impact pipeline** |

News Momentum is not one function away from working. It needs sourcing,
verification, event extraction, entity and market linking, expected-versus-
actual reaction and persistence — a subsystem with its own data model. A
placeholder `news_feed` primitive would make it look like an afternoon's work,
so there isn't one. It is listed, visibly unavailable, with that exact reason.

Its eventual shape, when it is built:

```
News source → verification → event extraction → entity linking
  → market linking → impact reasoning → expected reaction
  → actual reaction → persistence → learning
```

---

## 3. What is proven, and how

| Claim | Evidence |
|---|---|
| Rules evaluate correctly against hand-built candle series | 254 pytest tests |
| Contract shape does not vary by evaluator | test across 9 templates |
| No strategy-specific code in the frontend | render test + source scan for template ids |
| Parser understands 6 phrasings of one strategy | `tests/test_parser.py` |
| Parser reports what it did not understand | same |
| Catalogue → adopt → contract → watch works against a real API | browser + live Postgres + sentinel-py + services/api |
| The workspace renders two unrelated strategies identically | browser, EMA-7 vs S/R Flip |
| Compliance gate rejects banned language and metadata | `tests/test_notify.py` |
| Migrations apply from scratch with no drift from these tables | verified against Postgres 16 + pgvector |

### Bugs found by running it, not by reading it

Recorded because they say something about where the risk lives:

- Naive/aware datetimes broke **every** store write against a real database.
  No unit test caught it; they all mocked the store.
- `find_bullish_reclaim` returned only the newest reclaim, leaving the setup
  permanently "waiting" on the candle that had confirmed it.
- The impulse trim reassigned a loop variable, corrupting later iterations —
  latent through two features.
- Zone touches counted the departure candle, so every zone was born "tested".
- The web app's design tokens (`bg-bg1`, `border-line`) did not exist in the
  design system, so P7 rendered unstyled.
- P7 shipped with no navigation entry: a working feature nobody could reach.
- The API build in the container predated the `adopt` and `contract` routes,
  so both 404'd through the browser until rebuilt.

---

## 4. What is NOT proven — the honest gap

> **No observation has ever been produced from real market data.**

Everything downstream of the evaluator has been exercised only against
hand-built candles and empty states:

- `conditions` met/unmet against a live tape
- `latestObservation.context` — the evaluator's own measurements
- `lifecycle` events: SETUP → VALIDATION → REJECTION → OUTCOME
- **Every analytics segment**: pullback depth, VWAP test ordinal, level age,
  zone freshness, flag tightness, liquidity stage — all built, all at zero
  samples
- Performance expectancy, MFE/MAE (`MEANINGFUL_SAMPLE = 30` never approached)

**Blocker:** no `DHAN_ACCESS_TOKEN` / `DHAN_CLIENT_ID` and no
`BrokerCredential` row in any environment this work has had access to, so the
live-feed bridge on port 4600 cannot serve real candles.

**Unblocks, in order of preference:**

1. Dhan credentials in the remote environment → full walkthrough during market
   hours, custom strategy and EMA-7.
2. A recorded real-candle fixture from a genuine session, replayed through the
   bridge. Weaker than live, but real data, and exercises the whole path.
3. Someone runs it against a credentialled stack and reports what the browser
   shows.

Fabricating candles to produce a green-looking demo is not on this list. It
would prove nothing and would violate principle 5 in PRODUCT.md.

---

## 5. Sequence from here

```
Parser correctness            ✅ done (PR #13)
        ↓
Real Dhan / live-candle watch ⛔ BLOCKED on credentials
        ↓
Real lifecycle                  waits on the above
        ↓
Real performance                waits on the above
        ↓
News Research / Market Impact   not started, deliberately
```

Building the most complex subsystem in the product on top of a watch pipeline
that has never seen real data would put the hardest work on the least-tested
foundation.

---

## 6. Known open items

| Item | Note |
|---|---|
| `Compose config valid` CI check | Red on `main` and every branch. `.env.prod` is gitignored and absent in CI; six services reference it, five predating this work. **Isolated as separate infrastructure cleanup.** |
| `Migration drift` CI check | Red on `main`. `Order.updatedAt` carries a DB default from migration `20260722100001` that `schema.prisma:330` does not declare. `Order` is trading-critical; deciding which side is authoritative is its own change. |
| Two strategy surfaces converged | The text-authored composer and the contract-driven panel now sit in one section. No further divergence expected. |
| `services/sentinel` (TS, 4010) retirement | Untouched and still running. A separate decision. |
| Options watch pickers | Expiry/strike need the bridge on 4600; index watches work without it. |
| `MEANINGFUL_SAMPLE = 30` | Performance is reported below it with an explicit small-sample note rather than hidden. |
