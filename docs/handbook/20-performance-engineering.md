# Chapter 20 — Performance Engineering

**Status: 🟡 for techniques (several good ones are already implemented). 🔴 for measurement — there is no profiling harness, no budget enforcement in CI, and no RUM. Every number in this chapter is a target, and §20.9 is the remediation plan.**

---

## 20.1 The 20 ms target, defined precisely

> *"Every UI interaction should target approximately 20 ms responsiveness where technically feasible."*

Taken literally, 20 ms is impossible for anything crossing a network. Mumbai-to-Mumbai RTT alone is 5–15 ms before TLS, before the server does anything, before the response is parsed. So the target needs a precise definition, and here it is:

> **20 ms from user input to first visual acknowledgement.**

Not from input to final correct data. From input to *the interface visibly responding.*

```
   t=0      user clicks BUY
   t=2ms    button enters its pressed state                  ← local CSS
   t=8ms    an optimistic order row appears in the blotter   ← local state
   t=15ms   "Placing…" renders                               ← local state
   ────────────── the user has been answered ──────────────
   t=180ms  server confirms; the row reconciles to PENDING
```

The user experiences a 15 ms response. The network took 180 ms. Both statements are true, and only the first is what "responsiveness" means.

### 20.1.1 The three-tier model

```
   TIER 0 — ACKNOWLEDGEMENT     ≤20 ms    local state, CSS
            "I heard you"                  NEVER touches the network

   TIER 1 — OPTIMISTIC RESULT   ≤50 ms    local computation, cache
            "here's what I think happens"

   TIER 2 — CONFIRMED RESULT    ≤500 ms   network round trip
            "here's what actually happened"
```

**Every interaction must have a Tier 0.** An interaction with no Tier 0 feels broken regardless of how fast Tier 2 is — and an interaction with a good Tier 0 feels fast even when Tier 2 takes half a second.

### 20.1.2 The rule that follows

> ⚠️ **Never put a network call on the critical path between a user's input and the first pixel change.**

This is the single most-cited performance rule in code review here.

---

## 20.2 The performance budget

| Interaction | Budget | Tier | Status |
|---|---|---|---|
| Keystroke → visual ack | **≈20 ms** | 0 | ⚪ |
| Button press → state change | ≤20 ms | 0 | ⚪ |
| Hover / toggle / tab switch | ≤150 ms | 0 | ⚪ |
| Panel open | 200–300 ms | 1 | ⚪ |
| Route change | ≤350 ms | 1 | ⚪ |
| Quote tick → cell update | ≤16 ms (one frame) | 1 | ⚪ |
| Chart tick → bar update | ≤16 ms | 1 | ⚪ |
| Indicator toggle | ≤50 ms | 1 | ⚪ |
| Order placement → optimistic row | ≤50 ms | 1 | ⚪ |
| Order placement → confirmation | ≤500 ms | 2 | ⚪ |
| API read, cached | ≤50 ms | 2 | ⚪ |
| API read, uncached p95 | ≤200 ms | 2 | ⚪ |
| Sentinel `/observe` p95 (gate closed) | ≤300 ms | 2 | ⚪ |
| Sentinel `/observe` p95 (gate open) | ≤2,000 ms | 2 | ⚪ |
| AI first token | ≤800 ms | 2 | ⚪ |
| Dashboard LCP (cold) | ≤2,000 ms | — | ⚪ |
| Dashboard TTI | ≤3,000 ms | — | ⚪ |
| Initial JS bundle | ≤250 KB gz | — | ⚪ |

**Every row is ⚪.** That is the honest state, and it is the reason this chapter's most important section is §20.9 rather than any of the technique sections.

### 20.2.1 The motion budget

From `packages/ui/src/styles/tokens.css`, mirroring `GENESIS-V2-BLUEPRINT.md` §3:

```css
--dur-micro: 150ms;   /* hover, toggle, focus */
--dur-panel: 250ms;   /* panel open/close, dock change */
--dur-route: 300ms;   /* route transition */
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
```

> **Motion communicates state; it never gates an action.** A 250 ms panel animation must not delay the panel's content being interactive. Animate the container; render the content immediately.

---

## 20.3 Frontend performance

### 20.3.1 What is implemented 🟢

| Technique | Where | Effect |
|---|---|---|
| **`series.update()` not `setData()`** | `TradeChart` | one bar patched per tick; zoom/pan preserved |
| **Ref-not-dependency for tick values** | `useCandles` | prevents ~4 reloads/second |
| **Selector-scoped Zustand subscriptions** | everywhere | cell-level re-renders |
| **Lazy panels** (`next/dynamic`, `ssr:false`) | `PANEL_REGISTRY` | chart + option chain out of the initial bundle |
| **Client-side indicator computation** | `lib/technicals.ts` | ~50 μs vs. a 50–200 ms round trip |
| **CSS custom properties for theming** | `packages/ui` | theme change costs zero JS |
| **Blocking inline theme script** | `app/layout.tsx` | no flash of the wrong theme |
| **Canvas for dense data** | charts, sparklines | 500 candles = draw calls, not DOM nodes |

### 20.3.2 ⭐ The cell-granularity rule

> Real-time surfaces update at **row/cell granularity** — never full-page re-renders.

An option chain is ~40 strikes × ~14 columns ≈ 560 numeric cells, several changing per tick.

```tsx
// ❌ every cell re-renders when ANY quote changes
const quotes = useQuoteStore(s => s.quotes);
return <td>{quotes[symbol]?.ltp}</td>;

// ✅ this cell re-renders only when ITS ltp changes
const ltp = useQuoteStore(s => s.quotes[symbol]?.ltp);
return <td>{ltp}</td>;
```

**Select the narrowest slice you need.** Selecting an object re-renders on any key change; selecting a primitive re-renders only when that primitive changes. At 4 Hz across 560 cells that is the difference between a terminal and a slideshow.

### 20.3.3 ⭐ The ref pattern, generalised

```ts
const liveRef = useRef(livePrice);
liveRef.current = livePrice;         // every render; triggers nothing

useEffect(() => { /* reads liveRef.current */ }, [symbol, interval]);
```

> **A value that changes at tick frequency but is only *read* inside an effect belongs in a ref, not in the dependency array.**

Applies to: live price in an order ticket, live P&L in a blotter, live quote in depth, live LTP in the chart's fallback path.

### 20.3.4 🔵 Not yet done

| Gap | Cost today | Fix |
|---|---|---|
| **No virtualisation** | a 500-row option chain renders 500 rows | `@tanstack/react-virtual` over the chain and the blotter |
| **No `React.memo` discipline** | some panels re-render unnecessarily | memo + stable callbacks on panel roots |
| **No shared candle cache** | N chart panels = N fetches, N arrays | cache keyed `(symbol, interval)` |
| **No bundle budget in CI** | size regressions ship silently | `size-limit` as a blocking check |
| **No route prefetch tuning** | route change may miss its budget | `<Link prefetch>` on sidebar items |
| **No image optimisation audit** | — | `next/image` everywhere |

**Virtualisation is the highest-value item.** It is the difference between an option chain that scrolls at 60 fps and one that stutters, and it is a well-understood library change rather than an architectural one.

---

## 20.4 Backend performance

### 20.4.1 What is implemented 🟢

| Technique | Where |
|---|---|
| 2-second snapshot cache | `MarketPriceService` — one bridge call covers a whole matching tick |
| One `/quotes` call per matching tick | polling cost does not scale with order count |
| Incremental wallet maintenance | portfolio read is a read, not a fold over trade history |
| `include` instead of N+1 | `MatchingEngineService` loads instruments with orders |
| Indexed hot queries | `Order [status]` for the matching scan |
| Non-blocking enrichment | fire-and-forget research and outcome learning |

### 20.4.2 ⭐ The composite gate as a cost control

```
   85% of /observe:  no LLM  →  p95 ≈ 300 ms   →  ~₹0
   15% of /observe:  LLM     →  p95 ≈ 2,000 ms →  one 220-token call
```

A design that sent every observation to a model would be roughly 6× slower and 7× more expensive for structurally identical output. **The quality gate and the cost gate are the same line of code.**

### 20.4.3 🔵 The optimisation order for Sentinel

1. **Snapshot cache** keyed `snapshot:{symbol}:{15m-bucket}` — removes ~80 ms from every request and collapses concurrent observers of the same symbol onto one computation. Highest value by a wide margin.
2. **Parallelise the two `getCandles` calls** — currently sequential, independent.
3. **Move pattern persistence off the request path** — awaited today inside a try/catch; queue it.
4. **Cache historical similarity** by `(symbol, pattern)` — the answer changes slowly.
5. **Stream the LLM composition** — does not reduce total latency; transforms perceived latency.

### 20.4.4 🔵 The entitlement cache

`EntitlementsService.check()` runs up to three queries and is called on **every guarded request** — the most frequently executed database work in the API.

```
   key    entitlement:{userId}:{capability}
   TTL    60 s
   bust   subscription change · override change · plan change
```

> ⚠️ **Never cache the quota branch.** `UsageCounter` is the thing being metered; a cached quota decision lets a user exceed their limit by TTL × request rate.

---

## 20.5 Database performance

### 20.5.1 Query budget

| Class | Target |
|---|---|
| Point lookup by unique key | ≤2 ms |
| Indexed list, ≤100 rows | ≤10 ms |
| Matching-engine resting scan | ≤20 ms |
| Portfolio summary (2 queries) | ≤30 ms |
| Vector similarity, **indexed** 🔵 | ≤50 ms |
| Vector similarity, **unindexed (today)** | **unbounded — linear in table size** |
| Concept graph, 3 hops | ≤80 ms |

### 20.5.2 🔴 The one query that will fail first

**`MemoryRecord.embedding` has no index.** Every semantic search is a sequential scan over every memory.

```
   1,000 memories     → imperceptible
   10,000 memories    → noticeable
   100,000 memories   → the slowest query in the system
   1,000,000 memories → unusable
```

Memories are written **continuously** by Sentinel's pattern recognition. This is not a hypothetical growth curve; it is the designed behaviour of the system.

```sql
CREATE INDEX memory_embedding_idx ON "MemoryRecord"
  USING hnsw (embedding vector_cosine_ops);
```

HNSW over IVFFlat: better recall/latency, no training step, and it handles incremental inserts — which is exactly the write pattern here.

### 20.5.3 🔵 The partial index for resting orders

```sql
CREATE INDEX order_resting_idx ON "Order" (status)
  WHERE status IN ('OPEN', 'TRIGGER_PENDING');
```

Resting orders are a tiny fraction of all orders. A partial index stays small no matter how many `FILLED` rows accumulate, and this query runs 20 times a minute forever.

### 20.5.4 Transaction discipline

> ⚠️ **Never `await` a network call inside a transaction.** It holds a row lock for the duration of an HTTP round trip.

`OrderService.placeOrder` fetches the price *before* opening the transaction, which is exactly right and is worth copying.

---

## 20.6 Caching strategy

### 20.6.1 The hierarchy 🔵

```
  L0  In-process LRU        μs        per-instance; no coherence problem
      · concept graph (reseed-invalidated)
      · relation specs (immutable)
      · indicator results per (symbol, bar-bucket)

  L1  Redis                 ~1 ms     shared across instances
      · market snapshot     snapshot:{symbol}:{15m-bucket}
      · entitlement         entitlement:{userId}:{capability}   TTL 60 s
      · retrieval           retrieval:{hash}                    TTL 5 min
      · historical sim.     histsim:{symbol}:{pattern}          TTL 1 h

  L2  Postgres              ~5–50 ms  the durable truth
```

### 20.6.2 ⭐ Bucket keys beat TTLs

```
   snapshot:{symbol}:{floor(now / 15min)}
```

Bucketing by **bar boundary** rather than by wall-clock TTL gives three properties a TTL cannot:

1. Every observer of a symbol within the same bar sees the **identical** snapshot
2. Invalidation happens **exactly** when new information arrives
3. There is **no window** in which two users see different "current" structure for the same symbol

A 30-second TTL gives all three away for nothing.

### 20.6.3 What must never be cached

| Never | Why |
|---|---|
| Behavioural signals | depend on this user's trades, which change per request |
| The composite gate result | combines cached market data with uncached behaviour |
| **The Sentinel synthesis** | ⚠️ per-user; caching by `(symbol, pattern)` leaks one user's behavioural evidence to another |
| ⚖️ Compliance writes | every observation is a distinct audit event |
| The quota branch of an entitlement decision | it is the thing being metered |

### 20.6.4 The cache-invalidation rule

> **Every cache entry must have a documented invalidation trigger before it is added.** "It'll expire eventually" is not a strategy — it is how a user who upgraded waits a minute for access, or how a user whose subscription lapsed keeps it.

---

## 20.7 Rendering optimisation

### 20.7.1 The re-render decision tree

```
   Does this component read live data?
     │
     ├─ NO  → is it in a list of >50?
     │         ├─ YES → virtualise
     │         └─ NO  → nothing to do
     │
     └─ YES → does it read the NARROWEST slice possible?
                ├─ NO  → fix the selector          ← almost always the answer
                └─ YES → is the parent re-rendering it anyway?
                           ├─ YES → React.memo + stable callbacks
                           └─ NO  → done
```

**"Fix the selector" resolves most cases.** `React.memo` is the second answer, not the first, because a memo on a component with a broad selector solves nothing.

### 20.7.2 The list-rendering rule

| Rows | Approach |
|---|---|
| < 50 | render them all |
| 50–500 | virtualise if the rows update live |
| > 500 | always virtualise |

An option chain (40 strikes × 2 sides) sits right at the boundary and updates live — which is why it is the first virtualisation target.

### 20.7.3 `AnimatedNumber`

`packages/ui/src/components/AnimatedNumber.tsx` transitions a value without re-rendering its containing row. In a blotter where a P&L number updates continuously, animating the number in place rather than re-rendering the row is the difference between a smooth screen and a flickering one.

---

## 20.8 Network optimisation

### 20.8.1 🔵 Polling → push

Today the frontend polls. Each poll is a full HTTP request, a JSON parse, and a state update, whether or not anything changed.

```
   POLLING (today)                      SSE (specified)
   ───────────────                      ───────────────
   N clients × 1 req/2 s                N connections, events only on change
   full payload each time               only what changed
   latency = up to the poll interval    latency = propagation
   scales with clients × frequency      scales with clients × change rate
```

**In a quiet market SSE sends almost nothing.** Polling sends the same payload every two seconds regardless.

### 20.8.2 Payload discipline 🔵

```
   □ Return only the fields the screen uses (PositionDto already does this)
   □ Batch: one /quotes call for N symbols, never N calls
   □ Compress (gzip/brotli at Caddy)
   □ ETag / If-None-Match on slow-changing reads
   □ HTTP/2 (Caddy default) — multiplexing removes head-of-line blocking
```

### 20.8.3 The Dhan rate budget as a design input

Chapter 12 §12.4. Worth restating here because it is a *performance* constraint disguised as a rate limit:

```
   Option chain: 1 req per 3 s per (underlying, expiry)
   4 chains → a full round takes 12 s
   ⇒ any chain refreshes at best every 12 seconds
   ⇒ the option chain CANNOT be a tick-level surface,
     and the UI must show a refresh timestamp rather
     than animating as though it were live
```

Pretending otherwise is not a performance problem; it is a lie in the interface, and an options trader spots it in a minute.

---

## 20.9 🔴 Measurement — the actual gap

Everything above this section is technique. This section is the reason the chapter exists.

### 20.9.1 What does not exist

```
   ❌ no profiling harness           ❌ no load testing
   ❌ no benchmark suite             ❌ no RUM
   ❌ no performance budget in CI    ❌ no APM
   ❌ no slow-query logging          ❌ no bundle-size tracking
   ❌ no p50/p95/p99 for ANY endpoint
```

> **Every number in §20.2 is a target. Not one is a measurement.**

That is the honest state, and it means the platform cannot currently tell whether a change made things faster or slower.

### 20.9.2 The remediation plan, in cost order

**Week 1 — free wins**

```
   □ Postgres: log_min_duration_statement = 200
   □ Next.js build output → record bundle sizes per route
   □ A NestJS interceptor recording per-route duration to a histogram
   □ Lighthouse CI on the dashboard route, on every PR
```

**Week 2 — metrics**

```
   □ Prometheus + Grafana (docker-compose)
   □ http_request_duration_seconds{method,route,status}
   □ db_query_duration_seconds{model,operation}
   □ sim_matching_tick_duration_seconds
   □ sentinel_observe_duration_seconds
   □ One dashboard: p50/p95/p99 per endpoint
```

**Week 3 — budgets in CI**

```
   □ size-limit: fail the build if the initial bundle exceeds 250 KB gz
   □ Lighthouse CI: fail if LCP > 2.0 s on the dashboard
   □ A benchmark suite for the pure functions
     (applyFill, indicators, signals, the binary parser)
     → fail on a >20% regression
```

**Week 4 — load**

```
   □ k6 scenarios:
       · 100 concurrent users on the dashboard
       · 50 concurrent order placements
       · 500 resting orders through the matching engine
       · 200 concurrent /observe calls
   □ Record the breaking point for each
   □ Write the numbers into §20.2, replacing the targets
```

### 20.9.3 The benchmark suite 🔵

The pure functions are trivially benchmarkable and are the ones whose regression would be least visible:

```ts
bench('applyFill — close and flip',        () => applyFill(100, 500, 'SELL', 150, 520));
bench('rsi over 500 candles',              () => rsi(closes500));
bench('emotion.signals over 100 trades',   () => svc.signals(trades100));
bench('trap.signals over 500 candles',     () => svc.signals(snapshot500, trades));
bench('parse a Full packet (162 bytes)',   () => parsePacket(fullPacketBuffer));
bench('assemble context, 8k budget',       () => cm.assemble(request));
```

Cheap to write, fast to run, and they catch the class of regression where someone makes a hot loop quadratic without noticing.

### 20.9.4 The p-value discipline

> **Report p50, p95, and p99. Never report a mean.**

A mean latency of 80 ms is consistent with everyone being served in 80 ms, and with 95% of users served in 20 ms while 5% wait two seconds. Those are different products.

**p99 is the number that matters for a trading terminal**, because a trader who experiences one two-second freeze during a fast market remembers it far longer than the thousand fast interactions around it.

---

## 20.10 Profiling techniques

### 20.10.1 Frontend

| Tool | Finds |
|---|---|
| React DevTools Profiler | which components re-render and why |
| Chrome Performance panel | long tasks, layout thrash, main-thread blocking |
| Lighthouse | LCP, CLS, TBT, bundle weight |
| `performance.mark`/`measure` | custom interaction timing (Tier 0/1/2) |
| Bundle analyser | what is actually in the initial chunk |

**Start with the React Profiler's "why did this render?".** It answers the most common question directly, and the answer is usually a selector that is too broad.

### 20.10.2 Backend

| Tool | Finds |
|---|---|
| `EXPLAIN (ANALYZE, BUFFERS)` | the real query plan, not the imagined one |
| `pg_stat_statements` | which queries consume the most total time |
| Node `--prof` / `--cpu-prof` | CPU hotspots |
| `--inspect` + heap snapshots | leaks |
| clinic.js | event-loop blocking |

> ⚠️ **A query that is fast on 1,000 rows can be catastrophic on 1,000,000.** `EXPLAIN ANALYZE` against a *realistically sized* dataset, not a development one with fifty rows. A sequential scan of fifty rows is instant and tells you nothing.

---

## 20.11 The optimisation process

```
   1. MEASURE      never optimise on suspicion
   2. LOCATE       profile; find where the time actually goes
   3. HYPOTHESISE  state what you expect the change to save
   4. CHANGE       one thing
   5. MEASURE      did it match the hypothesis?
   6. RECORD       write the before/after into the vault
```

### 20.11.1 The rules

| Rule | |
|---|---|
| **Measure first, always** | The bottleneck is regularly not where anyone expected |
| **One change at a time** | Two changes give you one number and no attribution |
| **Optimise the p95, not the mean** | The mean hides the experience you are trying to fix |
| **Prefer removing work to doing it faster** | A cache that avoids a query beats a faster query |
| **Correctness first** | A fast wrong number is worse than a slow right one (Chapter 2 §2.11) |
| **Record the result** | So the next person does not re-derive it |

### 20.11.2 The performance review checklist

```
   □ Does this add a network call to a Tier 0 path?         ← §20.1.2
   □ Does this widen a Zustand selector?                    ← §20.3.2
   □ Does this add a tick-frequency value to a dep array?   ← §20.3.3
   □ Does this render an unbounded list without virtualising?
   □ Does this add an N+1 query?
   □ Does this query a column with no index?
   □ Does this await a network call inside a transaction?   ← §20.5.4
   □ Does this add to the initial bundle? (dynamic import?)
   □ Does this add an await to /observe's critical path?
   □ Does the new cache entry have a documented invalidation trigger?
```

---

## 20.12 Performance debt

| ID | Item | Severity | Effort |
|---|---|---|---|
| **PERF-1** | **No measurement of any kind** | **critical** | 2 weeks |
| PERF-2 | No pgvector index (DB-1) | **high** | hours |
| PERF-3 | No Redis → no shared cache (DB-2) | high | 1 day |
| PERF-4 | No Sentinel snapshot cache | high | 1 day |
| PERF-5 | No virtualisation on long lists | medium | 2 days |
| PERF-6 | Polling instead of push | medium | 3 days |
| PERF-7 | No bundle budget in CI | medium | hours |
| PERF-8 | No load testing | medium | 3 days |
| PERF-9 | No entitlement cache | low | hours |
| PERF-10 | No shared candle cache across chart panels | low | 1 day |
| PERF-11 | Sequential `getCandles` calls in the snapshot | low | minutes |

**PERF-1 gates everything else.** Without measurement, PERF-2 through PERF-11 are guesses about what matters — well-informed guesses, but guesses. The first two weeks of instrumentation will almost certainly reorder this table, and that reordering is the point.

---

*Next: [Chapter 21 — Testing](21-testing.md)*
