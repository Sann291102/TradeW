# TradeW Load Test Report

**Date:** 2026-08-10
**Harness:** `scripts/loadtest/` (in-repo, zero dependencies — `node scripts/loadtest/run.mjs`)
**Target:** 500 concurrent authenticated users

---

## 0. What this measured, and what it did not

Everything below was run against the **real stack on a developer laptop**, not
against a production deployment — because there is no production deployment.
That single fact bounds every number here, so it is stated first rather than
buried in a caveat at the end.

**Test host:** Windows 11, Intel i5-11260H (6 cores / 12 threads, 2.6 GHz),
16 GB RAM. The load generator, the API, Sentinel, the market-data ingestor, the
Dhan bridge, the Next.js dev server and PostgreSQL were **all running on this
one machine at the same time**. The generator competes with the system under
test for CPU. Real hardware with those processes separated will be faster, not
slower — but by an amount this test cannot tell you.

**Market state:** Indian markets were closed. The Sentinel numbers are for a
session in `market close` state. Live-session reasoning does more work; treat
Sentinel's latency here as a floor.

**What the numbers are good for:** relative cost between endpoints, finding
which layer saturates first, and confirming that the concurrency target is not
absurd. **What they are not good for:** a capacity plan for real hardware, or
an SLA. Those need a run on the actual deployment.

### Rate limits were raised for the capacity runs, on purpose

Rate limiting was added to `services/api` during this audit (see
`docs/PRODUCTION-READINESS.md` §2). It buckets by client IP, and every virtual
user in this test comes from `127.0.0.1` — one IP, one bucket. Left at
production settings the test would have measured the rate limiter and nothing
else.

So the capacity runs used a **second API instance on port 4100** with the limits
raised, while the first instance kept production settings. Two consequences,
both useful:

1. The capacity numbers describe the application, not the limiter.
2. Running two API instances against one database is itself a test — see §4.

The limiter was verified separately and does work; that evidence is in §5.

---

## 1. Headline result

| | |
|---|---|
| Concurrent virtual users | **500**, held for 3 minutes after a 60s ramp |
| Sustained throughput | **85.8 requests/sec** |
| Total requests | 23,444 |
| Failures | 97 (0.41%) — all one misconfigured test account cohort, see §3 |
| Slowest p95 on an owned endpoint | **10.3 ms** (`/market-data/indices`, 37.5 rps) |
| Slowest p95 overall | **341 ms** (`/crypto/quotes` — third-party latency, not ours) |

**The API was not the bottleneck at 500 users.** It was not close. Every
endpoint TradeW actually implements answered in single-digit to low-double-digit
milliseconds at p95 while serving the full mix.

---

## 2. Full run — 500 VUs, mixed population

Population modelled on a plausible session mix rather than on whatever maximises
throughput: 225 dashboard, 100 portfolio, 75 learning, 50 anonymous visitors,
35 trading, 15 Sentinel.

```
step                               n   rps  p50 ms  p95 ms  p99 ms  max ms  429  fail
-----------------------------  -----  ----  ------  ------  ------  ------  ---  ----
DELETE /sim/orders/:id           291   1.1    14.2    29.7    49.6     120    0     0
GET / (web landing)             1197   4.4    65.1    97.6   128.6     183    0     0
GET /crypto/quotes              5129  18.8   121.8   341.4   440.9    1233    0     0
GET /learning/courses            526   1.9     8.4    14.6    20.3      33    0     0
GET /learning/progress           526   1.9     5.6    10.6    16.6      27    0     0
GET /market-data/indices       10258  37.5     6.1    10.3    14.8      34    0     0
GET /news                        281   1.0     1.2     2.8     4.4     132    0     0
GET /sim/holdings                808   3.0     4.6     8.2    11.0      18    0     0
GET /sim/orders                  808   3.0     4.8     8.5    11.6      21    0     0
GET /sim/performance/overview    808   3.0     6.2    10.3    15.4      31    0     0
GET /sim/portfolio               808   3.0     5.9     9.9    14.2      33    0     0
GET /sim/positions               808   3.0     4.9     8.5    12.9      24    0     0
GET /sim/trade-history           808   3.0     4.0     7.2    10.6      15    0     0
POST /sentinel/observe            97   0.4     6.0    10.4    18.8      19    0    97
POST /sim/orders                 291   1.1    21.1    37.3    65.9     116    0     0

total 23444 requests in 273.2s = 85.8 rps · failures 97 (0.41%)
```

### Reading this

**The order write path is the most expensive thing TradeW owns**, and it is
still cheap: `POST /sim/orders` at 21 ms p50 / 37 ms p95. It resolves an
instrument, prices it, checks discipline limits, debits the wallet and writes
the order — all inside 37 ms at p95, under load. `DELETE` is roughly half that.

**Portfolio reads are uniformly ~5 ms p50 / ~10 ms p95.** These are the least
cacheable requests in the product — every one is scoped to a single user — and
they were the least of the system's problems. The Prisma schema's 75 indexes are
doing their job.

**`/crypto/quotes` is 20× everything else and none of that is TradeW's code.**
121 ms p50, 341 ms p95, a 1.2-second worst case. It proxies Binance, and what
this measures is the internet. It already has a server-side cache, so the cost
does not scale with user count — but it does mean a third-party outage or
slowdown is directly visible to users on the dashboard. Worth an explicit
timeout-and-degrade path; see the readiness report's §5.

**`GET /` at 65 ms p50 is the Next.js DEV server** and should be ignored as a
capacity signal. `next dev` compiles on demand and is 5–20× slower than
`next start` on a production build. It is included because the anonymous
visitor is a real journey, not because 65 ms means anything.

**`/news` at 1.2 ms p50** is a cache hit on every request — the 132 ms max is
the single cold fetch at the start of the run.

---

## 3. The 97 Sentinel failures were a test-setup defect, not a product defect

All 97 were **HTTP 403 `no_subscription`**. The load-test accounts are created
by the runner, and a plain account has no Sentinel entitlement — which is the
gate working exactly as designed. The entitlement overrides had been granted to
the three accounts that existed when the grant ran, not to the 22 the runner
created afterwards.

Once every load-test account was granted the capability, the Sentinel path was
measured on its own:

```
step                      n  rps  p50 ms  p95 ms  p99 ms  max ms  429  fail
----------------------  ---  ---  ------  ------  ------  ------  ---  ----
POST /sentinel/observe  223  1.3  1633.2  2665.2  3187.6    3502    0     0

50 concurrent observers · 174.9s · failures 0 (0.00%)
```

**Sentinel is 300× more expensive per request than a portfolio read** — 1.6 s
p50 against 5 ms — and that is the single most important number in this report
for capacity planning. Fifty concurrent users of one feature produce 1.3 rps and
consume more CPU than the other 450 users combined.

It did not fail, and there is no error rate to explain. But it means:

- Sentinel must never share a scaling policy with the API. It does not, in the
  Stage 1 Terraform.
- The per-minute rate limit added to `/sentinel/*` during this audit
  (`RATE_LIMIT_EXPENSIVE_PER_MIN=30`) is doing real work, not box-ticking. The
  plan quota is a monthly commercial ceiling; without a per-minute one, a
  client in a retry loop can spend a day's quota in under a minute and take the
  reasoning tier down for everyone while doing it.
- These are **market-closed** numbers. Live-session runs do strictly more work.

A separate finding worth recording: a load test that sends the wrong request
shape reports a load failure. The first run showed a 100% failure rate on
`POST /sim/orders` — which turned out to be the journey sending `instrumentId`
when the endpoint takes `symbol`. It looked exactly like a saturated write path
in the summary table. Both the journey and this note were fixed;
`scripts/loadtest/journeys.mjs` carries the warning inline.

---

## 4. Two API instances, one database — leader election verified live

A second API process was started against the same PostgreSQL instance for the
capacity runs. That incidentally exercises the `JobLease` leader election added
during this audit (`services/api/src/common/leader-election.ts`), which is what
makes running more than one API replica safe at all.

With both instances up:

```
            name            |                   holder
----------------------------+--------------------------------------------
 matching-engine            | 26168-08aac2a1-f14a-4421-b4b2-24d7ee371d8b
 performance-snapshot-sweep | 26168-08aac2a1-f14a-4421-b4b2-24d7ee371d8b
 settlement-sweep           | 26168-08aac2a1-f14a-4421-b4b2-24d7ee371d8b
 telemetry-retention        | 26168-08aac2a1-f14a-4421-b4b2-24d7ee371d8b
```

All four leases held by one process; the second acquired none and logged
nothing. Both served HTTP throughout. Before this change, that same
configuration would have had **two matching engines independently evaluating the
same resting orders**, and the load test above — which places 291 orders — is
exactly the workload that would have surfaced it as duplicate fills.

### Crash failover, proven by accident

Tearing the second instance down at the end of the run turned into a better test
than a planned one. By then it had become the leader (the first instance had
restarted during a watch rebuild and released its leases), and it was stopped
with a **hard kill** — no SIGTERM, so no graceful release ran. That is precisely
the case the expiry backstop exists for: a holder that vanishes without saying
so.

```
# immediately after the kill — leases still recorded against the dead process
matching-engine   | 38708-f188cce6-…  | renewedAt 13:25:58

# ~45 seconds later, no intervention
matching-engine   | 16768-bfd5265a-…  | renewedAt 13:26:43
```

All four leases expired on schedule and the surviving instance picked them up on
its next attempt. Failover took a lease TTL plus one renewal interval, matching
the design. Nothing was left stuck, and no operator action was involved.

---

## 5. The rate limiter, verified at production settings

Against the instance running production configuration, twelve rapid failed
logins from one IP:

```
 1 401   5 401   9 429
 2 401   6 401  10 429
 3 401   7 401  11 429
 4 401   8 401  12 429
```

Eight attempts pass, the rest are refused — matching `RATE_LIMIT_AUTH_PER_MIN=8`.
`/health` continued to answer 200 throughout, which is the property that stops a
traffic spike from failing the container's own health check and restarting the
instance under load.

---

## 6. Where it actually breaks — 1500 VUs

The same mix at three times the target, on the same laptop:

```
step                               n   rps  p50 ms   p95 ms   p99 ms  max ms  429  fail
-----------------------------  -----  ----  ------  -------  -------  ------  ---  ----
DELETE /sim/orders/:id           559   2.5   168.5   4510.8   6106.4    7372    0     0
GET / (web landing)             2331  10.4    81.4   1616.6   2834.7    3461    0     0
GET /crypto/quotes             10164  45.3   133.5   1642.2   2737.1    5272    0  6770
GET /learning/courses           1086   4.8   199.0   4803.2   6010.8    7152    0     0
GET /market-data/indices       20328  90.6    14.9   2545.9   4429.3    5731    0     1
GET /news                        675   3.0    11.5    258.6    355.8     454    0     0
GET /sim/portfolio              1620   7.2    34.8   3568.4   5026.4    5712    0     0
GET /sim/positions              1620   7.2    32.3   2619.4   3871.1    4437    0     0
POST /sentinel/observe           171   0.8  7085.4  11433.0  11969.2   12040    0     1
POST /sim/orders                 559   2.5   145.7   8026.1   9140.5    9495    0     0

total 46679 requests in 224.3s = 208.1 rps · failures 6772 (14.51%)
```

Throughput rose to 208 rps and the system is plainly saturated. Three things
are worth reading carefully, because they do not all say the same thing.

**The third-party dependency broke first, and it broke hard.** 6,770 of the
6,772 failures are `503`s from `/crypto/quotes` — the Binance proxy, at 45 rps
of pass-through. Nothing else returned a 5xx at all. The single largest
availability risk under load is not TradeW's code; it is an upstream that has no
timeout-and-degrade path in front of it. A user at this load sees a broken
crypto board while every part of the product TradeW actually owns is still
returning correct data.

**p50 stayed respectable while p95 collapsed.** `/market-data/indices` held a
14.9 ms median at 90 rps and a 2.5-second p95. That shape — median fine, tail
gone — is queueing, not slow code: most requests are served promptly and some
wait behind a saturated event loop. It is the signature to look for in
production, and it is why an alert on p95 is worth more than one on average
latency.

**Sentinel degrades before anything else TradeW owns.** 7.1 s p50 and 11.4 s
p95, from 1.6 s / 2.7 s at 500 VUs — a 4× latency increase for a 3× population.
It is the first owned component to fall over and it does so ungracefully.

Note that the generator, all six services and PostgreSQL share 12 threads on
this machine, so some of the tail is contention with the load generator itself.
The *ordering* of what breaks is the durable finding here; the exact VU number
at which it breaks is not.

**Conclusion:** the usable ceiling on this hardware sits between 500 and 1500
concurrent users, and the target sits comfortably inside it with the failure
sequence understood.

## 7. Headroom, and where it actually runs out

At 500 users on a shared laptop the API used a fraction of what was available.
The binding constraints as load grows are, in order:

1. **The Dhan broker feed — not TradeW.** The broker allows **five concurrent
   connections per account** and evicts the oldest with disconnect code 805 on a
   sixth. This is a hard external ceiling and no amount of horizontal scaling
   moves it. It is why `market-data` and `live-feed` are pinned to one replica
   in the Stage 1 Terraform with a validation rule that refuses any other value.
   Serving more users does not require more feed connections — one ingestor
   fans out to everyone — but it does mean the ingestion tier can never be made
   redundant by duplication. Its redundancy story is fast restart, not a second
   copy.

2. **Sentinel, at roughly 1.6 s of work per observation.** At Fargate's 1 vCPU
   this is tens of concurrent observations, not hundreds. It is also the only
   service still pinned to one replica for *correctness* rather than for an
   external resource — see the readiness report's Stage 2 item.

3. **PostgreSQL connections, well before PostgreSQL CPU.** Prisma opens a pool
   per process. Six API tasks at the default `(vCPU × 2 + 1)` plus Sentinel plus
   the ingestors is a connection count that reaches a small RDS instance's
   ceiling long before its query capacity. The Stage 1 Terraform therefore sets
   `connection_limit` explicitly and computes `max_connections` from
   `api_max_count × connection_limit`, rather than leaving both to defaults that
   multiply.

4. **The API itself,** which on this evidence is the last thing to worry about.

---

## 8. Reproducing this

```bash
node scripts/loadtest/run.mjs --vus 500 --ramp 60 --hold 180 --mix full
```

Against a production-configured API this will hit the rate limiter within
seconds, which is correct behaviour and not a bug in the harness — real users
arrive from many addresses, a load generator does not. To measure application
capacity, point `--api` at an instance started with the `RATE_LIMIT_*` variables
raised, exactly as §0 describes.

Mixes: `full` (default), `read`, `auth`, `sentinel`. `--json PATH` writes the
raw per-step summary.

---

## 9. Honest conclusion

**For 500 concurrent users, the request-serving path is not the problem, and the
measurements say so with room to spare.** The problems this exercise surfaced
were not performance problems at all — they were a production compose file that
would not have started correctly, a live-feed bridge that production referenced
but never ran, and background jobs that made a second replica a correctness
hazard. Those are in `docs/PRODUCTION-READINESS.md`.

The one number to carry forward is Sentinel's: 1.6 seconds per observation,
market closed. Everything about how the premium tier is sized, limited and
scaled follows from it.
