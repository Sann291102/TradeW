# Sentinel — Live Validation Runbook

**Purpose:** validate the Phase 1–6 pipeline against the live Dhan feed during
one full NSE session. **Observation only.** No logic changes during the session
unless a correctness bug is found (see *Stop conditions*).

**Status going in:** 292 unit tests pass, 37/37 runtime assertions pass, 0 type
errors across `services/sentinel`, `services/api`, `apps/web` and the script
project. **Nothing in Phases 1–6 has ever run against real market data.**

---

## 0. Why this session exists

Every number in the pipeline is currently either arithmetic or a plausible
default. This session is the first time the following are exercised for real:

| Never yet run against real data |
|---|
| `CandleMarketDataProvider` live-feed path under session conditions |
| Swing/structure detection on real 15m bars |
| Liquidity pool clustering and sweep-vs-acceptance on real wicks |
| The four-condition publication gate with real corroboration |
| Per-strategy lifecycle transitions across a full session |
| A completed lifecycle writing an outcome to the Brain |
| `OutcomeLearningService` tagging that outcome 15 minutes later |
| The post-close adaptive calibration pass |

---

## 1. Pre-session checklist (before 09:15 IST)

```bash
npm run build -w @tradew/ai-core
```
`@tradew/ai-core` ships unbuilt in a fresh workspace and every boot dies with
`runAgentRun is not a function` without this.

**Then, in order:**

1. **Refresh the Dhan token.** `DHAN_ACCESS_TOKEN` expires ~15:21 IST daily — it
   will die *before the close*, mid-session. Prefer the 12-month API key/secret.
   A token that expires at 15:21 will corrupt the last 9 minutes of the session
   and the post-close calibration pass that follows it.
2. **Start the bridge** (`dhan-bridge`, port 4600) and confirm real data:
   ```bash
   curl -s "http://localhost:4600/quotes" | head -c 300
   ```
   Expect real index/stock rows. If this is empty, stop — everything downstream
   observes nothing.
3. **Set `SENTINEL_LIVE_FEED_URL=http://localhost:4600`** in
   `services/sentinel/.env`. Without it the provider falls to the `Candle`
   table and then to a 503.
4. **Single replica only.** `services/sentinel` must run as ONE instance —
   `AdaptiveCalibrationService` holds calibration state and its once-per-day
   guard in process memory (see the ⚠️ block in that service). Two replicas
   apply the daily weight adjustment twice, compounding.
5. **Confirm observation logging is on** — `SENTINEL_OBSERVATION_LOG` unset or
   anything other than `false`.
6. Start `sentinel` (4010), `api` (4000), `web` (3000).
7. Sign in and confirm the `sentinel` entitlement is granted for the test user.

**Capture the session log to a file** — this is the primary artefact:
```bash
npm run start:dev -w @tradew/sentinel 2>&1 | tee sentinel-live-2026-08-07.log
```

---

## 2. What to record

One `OBSERVE` line is emitted per observation, carrying every event type:

```
OBSERVE NIFTY | state=SIDE_IN_FOCUS confidence=78.4/70 published=true
  corroboration=2 conflicts=0 detections=[orb-retest:validated]
  structure=uptrend/break-of-structure behaviour=continuation@0.62
  regime=trending consensus=bullish(3/4,abstain=1)
  lifecycleChanges=[orb-retest→SIDE_IN_FOCUS] sideInFocus=CE
```

| Requested event | Where it appears |
|---|---|
| Detected strategy | `detections=[...]` |
| Publication decision | `published=` + `blockedBy=` when false |
| Confidence calculation | `confidence=score/threshold` (full breakdown in the `/observe` response) |
| Lifecycle transition | `lifecycleChanges=[...]`, plus `StrategyLifecycleService` per-transition lines |
| Brain write | `recorded <outcome> outcome for <symbol> <strategy>` |
| Learning event | `AdaptiveCalibrationService` lines, post-close |

**Also capture:** 3–4 full `/observe` JSON responses at different session
phases (open, mid-morning, afternoon, near close). The log line is a summary;
the JSON carries the confidence factor breakdown, every gate condition, and the
chart annotations.

---

## 3. Session timeline

| Time (IST) | What to verify |
|---|---|
| **09:15–09:30** | Data flows at all. Structure reports `undefined` early — correct, not a bug: swings need confirmed bars on both sides. |
| **09:45** | Opening range established; `opening-range` annotation present. |
| **10:00–11:00** | Prime setup window. Watch for `FORMING → CONFIRMED` transitions and what `blockedBy` says when the gate holds. |
| **~11:00** | **First Brain write.** A lifecycle reaching MOVE_COMPLETE/INVALIDATED must log `recorded ... outcome`. |
| **+15 min after any write** | `OutcomeLearningService` tags that occurrence. This is the step that has never run live. |
| **12:00–14:00** | Regime shifts. Confirm `regime=` changes and that lifecycle `MOMENTUM_WEAKENING` appears on fading moves. |
| **14:45+** | Time-risk deduction should appear in the confidence breakdown. |
| **15:30** | Session close. |
| **~15:45** | **Adaptive calibration pass.** `shouldRunDailyPass` fires after the close. Expect the pass to log, and calibrations to appear in `status()`. |

---

## 4. Expected behaviour that is NOT a bug

Recording these up front so they are not "fixed" mid-session:

- **Sentinel will be very quiet.** On a cold Brain, corroboration (condition 4)
  will usually be the binding constraint — historical corroboration needs
  outcome-tagged occurrences that only accumulate by running. Expect
  `blockedBy=corroboration` to dominate early.
- **`option-chain` abstains on every observation.** `getOptionChain()` returns
  `[]`. `abstain=1` minimum is correct and honest.
- **`news` abstains.** Same reason.
- **Two of seven confidence factors sit at ~50.** Option chain and news have no
  data; they are held neutral rather than invented.
- **Structure reads `undefined` for the first ~5 bars.** By design.
- **A 503 from `/observe`** means no real data for that symbol — the provider
  refusing to simulate. Check the bridge, not the code.
- **`regime=unclassified`** until a market profile is classifiable.

---

## 5. Stop conditions — pause and investigate

Modify logic ONLY for these:

1. **A directive leaks** — any `buy`/`sell`/`exit`/`target`/`stop loss` in
   user-facing output. Highest severity; the compliance backstop should make
   this impossible.
2. **`published=true` with `corroboration<2`, an unmet mandatory rule, or
   `conflicts>0`** — the publication gate is not holding.
3. **A Side in Focus appears while `published=false`** — the two-gate defect
   fixed today has regressed.
4. **A lifecycle records an outcome more than once** for the same setup —
   inflates the base rate the live-performance gate reads.
5. **`MOVE_COMPLETE` recorded on a move that went against the setup** —
   direction-aware measurement is broken.
6. **Memory growth** — `StrategyLifecycleService` map should stay bounded
   (date eviction + 5 000 cap).
7. **Sweep classification inverted** — price closing *beyond* a level reported
   as a reclaimed sweep.

Anything else: **write it down, do not touch it.**

---

## 6. Post-session deliverables

1. The full session log.
2. The captured `/observe` JSON snapshots.
3. A count of: observations, detections, publications, `blockedBy` reasons
   (histogram), lifecycle transitions by type, Brain writes, outcomes tagged.
4. `AdaptiveCalibrationService.status()` output after the close.
5. A list of every parameter that looked wrong against real data — especially
   `MOVE_COMPLETE_PCT` (0.6%), swing `strength` (2), liquidity tolerance
   (0.05%), and `MAX_RELIABILITY_ADJUSTMENT` (±25%). **These were chosen for
   plausibility, never calibrated.** This session is the first evidence.

---

## 7. Known limitations going in

- No TradingView Charting Library — annotations are computed and returned but
  nothing renders them on a chart (licensing decision outstanding).
- Option-chain and news providers absent (product decisions outstanding).
- The market clock is **holiday-blind** (`market-clock.spec.ts` pins this
  deliberately). If tomorrow is an NSE holiday, the watch will sweep and find
  nothing rather than knowing it is closed.
- The `OBSERVE` log line executes (proven — every `observe()` in the runtime
  harness passes with it in place) but its **rendered text has never been seen**;
  Nest's logger is suppressed in that harness. Eyeball the first line at 09:15.
